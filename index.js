require("dotenv").config();
const { Telegraf, Markup, session } = require("telegraf");
const mongoose = require("mongoose");
const schedule = require("node-schedule");
// Helper function to escape HTML
const escapeHtml = (text) => {
  return text.replace(/[<>&]/g, function(c) {
    return {
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;'
    }[c];
  });
};


// Initialize bot with session middleware
const bot = new Telegraf(process.env.BOT_TOKEN);

// Session configuration with default values
bot.use(session({
  defaultSession: () => ({
    currentMenu: null,
    waitingForBroadcast: null,
    waitingForUpload: false,
    broadcastData: null,
    waitingForPaymentProof: null,
    sentBroadcastMessages: []
  })
}));
mongoose.connection.on('connecting', () => console.log('Connecting to MongoDB...'));
mongoose.connection.on('connected', () => console.log('Connected to MongoDB'));
mongoose.connection.on('error', (err) => console.error('MongoDB connection error:', err));
mongoose.connection.on('disconnected', () => console.log('Disconnected from MongoDB'));
// Suppress punycode warning
process.removeAllListeners('warning');

// Configuration
const admins = process.env.ADMINS.split(',').map(id => id.trim());
const VIDEO_BATCH_SIZE = parseInt(process.env.VIDEO_BATCH_SIZE) || 10;
const MESSAGE_DELETE_MINUTES = parseInt(process.env.MESSAGE_DELETE_MINUTES) || 30;
const PURCHASE_GROUP_LINK = process.env.PURCHASE_GROUP_LINK || "https://t.me/yourpurchasegroup";
const PURCHASE_GROUP_PRICE = process.env.PURCHASE_GROUP_PRICE || "₹99";
const GROUP_LINK = process.env.GROUP_LINK || "https://t.me/yourgroup";
let CHANNEL_IDS = process.env.CHANNEL_IDS ? process.env.CHANNEL_IDS.split(',') : [];

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch(err => console.error("❌ MongoDB connection error:", err));

// MongoDB Models
const userSchema = new mongoose.Schema({
  userId: Number,
  dailyCount: { type: Number, default: 0 },
  lastReset: { type: Date, default: new Date() },
  isPremium: { type: Boolean, default: false },
  hasPurchaseGroupAccess: { type: Boolean, default: false },
  viewedVideos: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Video' }],
  sentMessages: [{
    messageId: Number,
    chatId: Number,
    deleteAt: Date
  }]
});

const videoSchema = new mongoose.Schema({
  fileId: String,
  fileType: String,
  addedAt: { type: Date, default: Date.now }
});

const broadcastSchema = new mongoose.Schema({
  messageId: Number,
  chatId: Number,
  content: Object,
  targetType: String, // 'user', 'group', or 'channel'
  sentAt: { type: Date, default: Date.now }
});

const channelSchema = new mongoose.Schema({
  channelId: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  username: String,
  inviteLink: String,
  addedAt: { type: Date, default: Date.now },
  addedBy: { type: Number, required: true } // Telegram user ID of admin who added it
});

const User = mongoose.model("User", userSchema);
const Video = mongoose.model("Video", videoSchema);
const Broadcast = mongoose.model("Broadcast", broadcastSchema);
const Channel = mongoose.model("Channel", channelSchema);

// Helper functions
const isAdmin = (userId) => admins.includes(userId.toString());

const clearMenuState = (ctx) => {
  ctx.session.currentMenu = null;
  ctx.session.waitingForBroadcast = null;
  ctx.session.waitingForUpload = false;
  ctx.session.waitingForPaymentProof = null;
};

const scheduleDeletion = async (userId, messageIds, chatId) => {
  const deleteAt = new Date(Date.now() + MESSAGE_DELETE_MINUTES * 60000);
  await User.updateOne(
    { userId },
    { $push: { sentMessages: messageIds.map(id => ({
      messageId: id,
      chatId,
      deleteAt
    })) }}
  );
};

const cleanInactiveUsers = async () => {
  const users = await User.find({});
  for (const user of users) {
    try {
      // Try sending a hidden message to check if user is reachable
      await bot.telegram.sendMessage(user.userId, " ", { disable_notification: true });
    } catch (error) {
      if (error.description.includes('blocked') || 
          error.description.includes('deleted') ||
          error.description.includes('chat not found')) {
        console.log(`Removing inactive user ${user.userId}`);
        await User.deleteOne({ userId: user.userId });
      }
    }
  }
};

const sendUPIDetails = async (ctx, paymentType) => {
  clearMenuState(ctx);
  ctx.session.waitingForPaymentProof = paymentType;
  ctx.session.currentMenu = 'payment';

  const caption = paymentType === 'group' 
    ? `💳 *Purchase Group Access (${PURCHASE_GROUP_PRICE})*\n\n1. Scan the QR or copy UPI ID\n2. Send payment proof to verify`
    : `💳 *Premium Subscription*\n\n1. Scan the QR or copy UPI ID\n2. Send payment proof to verify`;

  const buttons = [
    [Markup.button.callback("📋 Copy UPI ID", "COPY_UPI")],
    [Markup.button.callback("🔙 Back", "MAIN_MENU")]
  ];

  await ctx.replyWithPhoto({ 
    source: paymentType === 'group' ? "./purchase_qr.png" : "./premium_qr.png" 
  }, {
    caption,
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons)
  });
};

const sendPurchaseGroupDetails = async (ctx) => {
  clearMenuState(ctx);
  ctx.session.currentMenu = 'purchase_group';

  const user = await User.findOne({ userId: ctx.from.id });

  if (user?.hasPurchaseGroupAccess) {
    await ctx.reply(`✅ You already have access to the purchase group!`, 
      Markup.inlineKeyboard([
        Markup.button.url("👥 Join Purchase Group", PURCHASE_GROUP_LINK),
        Markup.button.callback("🔙 Back", "MAIN_MENU")
      ])
    );
    return;
  }

  const buttons = [
    [Markup.button.callback(`💳 PAY ${PURCHASE_GROUP_PRICE}`, "PURCHASE_GROUP_PAY")],
    [Markup.button.callback("🔙 Back", "MAIN_MENU")]
  ];

  await ctx.replyWithPhoto({ source: "./purchase_group.png" }, {
    caption: `👥 *PURCHASE GROUP ACCESS (${PURCHASE_GROUP_PRICE})*\n\nGet exclusive content and offers in our private group!`,
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons)
  });
};

const sendDemoContent = async (ctx) => {
  clearMenuState(ctx);
  ctx.session.currentMenu = 'demo';

  try {
    const msg = await ctx.replyWithPhoto({ source: "./demo.jpg" }, {
      caption: "🆕 Here's a demo of our content (view once, expires in 20 seconds)",
      has_spoiler: true
    });

    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id);
      } catch (error) {
        console.error("Error deleting demo message:", error);
      }
    }, 20000);
  } catch (error) {
    console.error("Error sending demo:", error);
    await ctx.reply("⚠️ Error sending demo. Please try again.");
  }
};

const sendVideoBatch = async (ctx, user, isFirstBatch = true) => {
  clearMenuState(ctx);
  ctx.session.currentMenu = 'videos';

  try {
    let availableVideos = await Video.find({
      _id: { $nin: user.viewedVideos }
    });

    if (availableVideos.length < VIDEO_BATCH_SIZE) {
      await User.updateOne(
        { userId: user.userId },
        { $set: { viewedVideos: [] } }
      );
      availableVideos = await Video.find({});
    }

    const selectedVideos = availableVideos
      .sort(() => 0.5 - Math.random())
      .slice(0, VIDEO_BATCH_SIZE);

    const sentMessageIds = [];
    for (const video of selectedVideos) {
      const msg = await ctx.replyWithVideo(video.fileId);
      sentMessageIds.push(msg.message_id);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await scheduleDeletion(user.userId, sentMessageIds, ctx.chat.id);

    await User.updateOne(
      { userId: user.userId },
      { 
        $inc: { dailyCount: VIDEO_BATCH_SIZE },
        $addToSet: { viewedVideos: { $each: selectedVideos.map(v => v._id) } }
      }
    );

    // Show different buttons based on whether it's the first batch
    if (isFirstBatch) {
      await ctx.reply(
        "🎬 Enjoy your videos!",
        Markup.inlineKeyboard([
          [Markup.button.callback(`📥 GET ${VIDEO_BATCH_SIZE} MORE VIDEOS`, "GET_VIDEO")],
          [Markup.button.callback("🏠 MAIN MENU", "MAIN_MENU")]
        ])
      );
    } else {
      await showMainMenu(ctx);
    }

  } catch (error) {
    console.error("Error sending videos:", error);
    ctx.reply("⚠️ Error sending videos. Please try again.");
  }
};

const showMainMenu = async (ctx) => {
  clearMenuState(ctx);
  ctx.session.currentMenu = 'main';

  const buttons = [
    [Markup.button.callback(`📥 GET ${VIDEO_BATCH_SIZE} VIDEOS`, "GET_VIDEO")],
    [Markup.button.callback("💳 SUBSCRIBE", "SUBSCRIBE")],
    [Markup.button.callback("👥 PURCHASE GROUP", "PURCHASE_GROUP")],
    [Markup.button.callback("🆕 DEMO", "DEMO")]
  ];

  await ctx.reply("🎬 MAIN MENU", Markup.inlineKeyboard(buttons));
};

const showAdminMenu = async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  clearMenuState(ctx);
  ctx.session.currentMenu = 'admin';

  const buttons = [
    [Markup.button.callback("📢 Broadcast Message", "ADMIN_BROADCAST_TEXT")],
    [Markup.button.callback("📷 Broadcast Media", "ADMIN_BROADCAST_MEDIA")],
    [Markup.button.callback("🎥 Upload Media", "ADMIN_UPLOAD_MEDIA")],
    [Markup.button.callback("📺 Manage Channels", "ADMIN_MANAGE_CHANNELS")],
    [Markup.button.callback("🗑 Delete Broadcast", "ADMIN_DELETE_BROADCAST")],
    [Markup.button.callback("📊 Stats", "ADMIN_STATS")],
    [Markup.button.callback("🔙 Main Menu", "MAIN_MENU")]
  ];

  await ctx.reply("🛠 ADMIN PANEL", Markup.inlineKeyboard(buttons));
};

// Scheduled jobs
schedule.scheduleJob('*/1 * * * *', async () => {
  const now = new Date();
  const users = await User.find({
    "sentMessages.deleteAt": { $lte: now }
  });

  for (const user of users) {
    const toDelete = user.sentMessages.filter(m => m.deleteAt <= now);

    for (const msg of toDelete) {
      try {
        await bot.telegram.deleteMessage(msg.chatId, msg.messageId);
      } catch (error) {
        console.error(`Error deleting message ${msg.messageId}:`, error);
      }
    }

    await User.updateOne(
      { userId: user.userId },
      { $pull: { sentMessages: { deleteAt: { $lte: now } } } }
    );
  }

  // Clean inactive users daily at midnight
  if (new Date().getHours() === 0 && new Date().getMinutes() === 0) {
    await cleanInactiveUsers();
  }
});

schedule.scheduleJob("0 0 * * *", async () => {
  await User.updateMany({}, { dailyCount: 0, lastReset: new Date() });
});

// Bot commands
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  await User.findOneAndUpdate({ userId }, {}, { upsert: true, new: true });
  await showMainMenu(ctx);
});

bot.command("admin", showAdminMenu);

// Button handlers
bot.action("MAIN_MENU", showMainMenu);

bot.action("GET_VIDEO", async (ctx) => {
  const userId = ctx.from.id;
  const user = await User.findOne({ userId });

  if (!user) return ctx.reply("⚠️ Please send /start first");

  const dailyLimit = user.isPremium ? Infinity : parseInt(process.env.DAILY_VIDEO_LIMIT);

  if (user.dailyCount >= dailyLimit) {
    return ctx.reply(
      `⚠️ Daily limit reached (${dailyLimit} videos). Subscribe for unlimited access.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("💳 SUBSCRIBE", "SUBSCRIBE")],
        [Markup.button.callback("🔙 Back", "MAIN_MENU")]
      ])
    );
  }

  await ctx.answerCbQuery();
  const isFirstBatch = user.dailyCount === 0;
  await sendVideoBatch(ctx, user, isFirstBatch);
});

bot.action("SUBSCRIBE", async (ctx) => {
  await sendUPIDetails(ctx, 'premium');
});

bot.action("PURCHASE_GROUP", sendPurchaseGroupDetails);
bot.action("PURCHASE_GROUP_PAY", async (ctx) => {
  await sendUPIDetails(ctx, 'group');
});

bot.action("DEMO", sendDemoContent);

bot.action("COPY_UPI", async (ctx) => {
  await ctx.reply(`✅ UPI ID: \`${process.env.UPI_ID}\` (copy manually)`, { 
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      Markup.button.callback("🔙 Back", "MAIN_MENU")
    ])
  });
});

// Payment proof handler
bot.on("photo", async (ctx) => {
  if (ctx.chat.type !== 'private' || isAdmin(ctx.from.id)) return;

  ctx.session = ctx.session || {};

  if (ctx.session.waitingForPaymentProof) {
    await forwardPaymentToAdmin(ctx, ctx.session.waitingForPaymentProof);
    ctx.session.waitingForPaymentProof = null;
  }
});

async function forwardPaymentToAdmin(ctx, paymentType) {
  const userId = ctx.from.id;
  const caption = paymentType === 'group'
    ? `🧾 Purchase Group Payment from [${ctx.from.first_name}](tg://user?id=${userId})`
    : `🧾 Premium Payment from [${ctx.from.first_name}](tg://user?id=${userId})`;

  const buttons = Markup.inlineKeyboard([
    Markup.button.callback("✅ Verify", `VERIFY_${userId}_${paymentType.toUpperCase()}`),
    Markup.button.callback("❌ Reject", `REJECT_${userId}`)
  ]);

  await ctx.forwardMessage(process.env.ADMIN_GROUP_ID);
  await bot.telegram.sendMessage(process.env.ADMIN_GROUP_ID, caption, { 
    parse_mode: "Markdown", 
    ...buttons 
  });

  await ctx.reply("✅ Payment proof received! Admin will verify within 24 hours.");
}

// Verification handlers
bot.action(/^VERIFY_(\d+)_(GROUP|PREMIUM)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const userId = ctx.match[1];
  const verifyType = ctx.match[2].toLowerCase();

  if (verifyType === 'group') {
    await User.findOneAndUpdate({ userId }, { hasPurchaseGroupAccess: true });
    await ctx.reply(`✅ User ${userId} granted purchase group access.`);
    await bot.telegram.sendMessage(userId, `🎉 Purchase group access approved! Join here: ${PURCHASE_GROUP_LINK}`);
  } else {
    await User.findOneAndUpdate({ userId }, { isPremium: true });
    await ctx.reply(`✅ User ${userId} marked as premium.`);
    await bot.telegram.sendMessage(userId, "🎉 You are now a premium member! Enjoy unlimited videos.");
  }

  try {
    await ctx.deleteMessage();
  } catch (error) {
    console.error("Error deleting verification message:", error);
  }
});

bot.action(/^REJECT_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const userId = ctx.match[1];
  await ctx.reply(`❌ Payment from ${userId} rejected.`);
  await bot.telegram.sendMessage(userId, "⚠️ Your payment was rejected. Please contact support.");

  try {
    await ctx.deleteMessage();
  } catch (error) {
    console.error("Error deleting rejection message:", error);
  }
});

// Admin broadcast handlers
bot.action("ADMIN_BROADCAST_TEXT", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  clearMenuState(ctx);
  ctx.session.waitingForBroadcast = "text";
  ctx.session.currentMenu = 'broadcast';

  await ctx.reply("📢 Enter the broadcast message (or /cancel to abort):\n\nYou can mention:\n- @allusers (for all users)\n- @allgroups (for all groups)\n- @allchannels (for all channels)", 
    Markup.inlineKeyboard([
      Markup.button.callback("❌ Cancel", "ADMIN_CANCEL")
    ])
  );
});

bot.on("text", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  ctx.session = ctx.session || {};

  if (ctx.session.waitingForBroadcast === "text") {
    const buttons = [
      [Markup.button.callback("👤 Users", "CONFIRM_BROADCAST_TEXT_USERS")],
      [Markup.button.callback("👥 Groups", "CONFIRM_BROADCAST_TEXT_GROUPS")],
      [Markup.button.callback("📺 Channels", "CONFIRM_BROADCAST_TEXT_CHANNELS")],
      [Markup.button.callback("🌐 All", "CONFIRM_BROADCAST_TEXT_ALL")],
      [Markup.button.callback("❌ Cancel", "ADMIN_CANCEL")]
    ];

    await ctx.reply(
      `📢 Broadcast Preview:\n\n${ctx.message.text}`,
      Markup.inlineKeyboard(buttons)
    );

    ctx.session.broadcastData = { text: ctx.message.text };
    ctx.session.waitingForBroadcast = null;
  }
});

bot.action("ADMIN_BROADCAST_MEDIA", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  clearMenuState(ctx);
  ctx.session.waitingForBroadcast = "media";
  ctx.session.currentMenu = 'broadcast';

  await ctx.reply("📷 Send media to broadcast (photo/video/document):", 
    Markup.inlineKeyboard([
      Markup.button.callback("❌ Cancel", "ADMIN_CANCEL")
    ])
  );
});

// Fixed media upload handler
bot.action("ADMIN_UPLOAD_MEDIA", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  clearMenuState(ctx);
  ctx.session.waitingForUpload = true;
  ctx.session.currentMenu = 'upload';

  await ctx.reply("🎥 Send media to add to the database:", 
    Markup.inlineKeyboard([
      Markup.button.callback("❌ Cancel", "ADMIN_CANCEL")
    ])
  );
});

// Fixed media handler for both upload and broadcast
bot.on(["photo", "video", "document"], async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  ctx.session = ctx.session || {};

  if (ctx.session.waitingForUpload) {
    const fileType = ctx.message.photo ? 'photo' : 
                    ctx.message.video ? 'video' : 'document';
    const fileId = ctx.message.photo?.[0]?.file_id || 
                  ctx.message.video?.file_id || 
                  ctx.message.document?.file_id;

    try {
      const exists = await Video.findOne({ fileId });
      if (exists) {
        await ctx.reply("⚠️ This media already exists in the database.");
      } else {
        await Video.create({ fileId, fileType });
        await ctx.reply("✅ Media successfully uploaded to database!");
      }
    } catch (error) {
      console.error("Error uploading media:", error);
      await ctx.reply("⚠️ Error uploading media to database.");
    }
    ctx.session.waitingForUpload = false;
    return;
  }

  if (ctx.session.waitingForBroadcast === "media") {
    const fileId = ctx.message.photo?.[0]?.file_id || 
                  ctx.message.video?.file_id || 
                  ctx.message.document?.file_id;

    const buttons = [
      [Markup.button.callback("👤 Users", "CONFIRM_BROADCAST_MEDIA_USERS")],
      [Markup.button.callback("👥 Groups", "CONFIRM_BROADCAST_MEDIA_GROUPS")],
      [Markup.button.callback("📺 Channels", "CONFIRM_BROADCAST_MEDIA_CHANNELS")],
      [Markup.button.callback("🌐 All", "CONFIRM_BROADCAST_MEDIA_ALL")],
      [Markup.button.callback("❌ Cancel", "ADMIN_CANCEL")]
    ];

    await ctx.reply(
      `📢 Media Broadcast Preview\n\nCaption: ${ctx.message.caption || "None"}`,
      Markup.inlineKeyboard(buttons)
    );

    ctx.session.broadcastData = {
      fileId,
      type: ctx.message.photo ? "photo" : 
           ctx.message.video ? "video" : "document",
      caption: ctx.message.caption || ""
    };
    ctx.session.waitingForBroadcast = null;
  }
});

// Channel management
bot.action("ADMIN_MANAGE_CHANNELS", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  clearMenuState(ctx);
  ctx.session.currentMenu = 'manage_channels';

  const channels = await Channel.find();
  const buttons = [
    [Markup.button.callback("➕ Add Channel", "ADD_CHANNEL")],
    [Markup.button.callback("➖ Remove Channel", "REMOVE_CHANNEL")],
    [Markup.button.callback("📋 List Channels", "LIST_CHANNELS")],
    [Markup.button.callback("🔙 Back", "ADMIN_CANCEL")]
  ];

  await ctx.reply(
    "📺 Channel Management",
    Markup.inlineKeyboard(buttons)
  );
});

// Updated ADD_CHANNEL handler
// Add Channel - Initiation
  // Add Channel Command
// 1. First, add this enhanced debug utility at the top of your file:
const fs = require('fs');
const debug = {
  log: (...args) => {
    const message = `[DEBUG][${new Date().toISOString()}] ${args.join(' ')}\n`;
    console.log(message);
    fs.appendFileSync('bot_debug.log', message);
  },
  error: (...args) => {
    const message = `[ERROR][${new Date().toISOString()}] ${args.join(' ')}\n`;
    console.error(message);
    fs.appendFileSync('bot_errors.log', message);
  }
};

// 2. Replace your channel management code with this:

// Add Channel Command
bot.action("ADD_CHANNEL", async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) {
      debug.log('Non-admin access attempt to ADD_CHANNEL by:', ctx.from.id);
      return ctx.answerCbQuery("❌ Admin only");
    }

    // Clear previous state and set new
    ctx.session = ctx.session || {};
    ctx.session.waitingForChannelAdd = true;
    ctx.session.currentMenu = 'add_channel';

    debug.log('Admin started channel addition:', ctx.from.id, 'Session:', ctx.session);

    await ctx.reply(
      `📢 <b>How to add a channel:</b>\n\n` +
      `1. Add @${ctx.botInfo.username} as admin to your channel\n` +
      `2. Make sure bot has <b>post messages</b> permission\n` +
      `3. <b>Forward</b> any message from that channel here\n\n` +
      `<b>OR</b> send the channel ID (like @channelname or -1001234567890)\n\n` +
      `<i>Current status: Waiting for channel info...</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          Markup.button.callback("❌ Cancel", "ADMIN_CANCEL")
        ]),
        disable_web_page_preview: true
      }
    );

    await ctx.answerCbQuery();
  } catch (error) {
    debug.error('ADD_CHANNEL command failed:', error);
    await ctx.reply('⚠️ Error starting channel addition');
  }
});

// Channel Message Handler
bot.on('message', async (ctx) => {
  try {
    debug.log('Received message:', {
      text: ctx.message.text,
      forwardFrom: ctx.message.forward_from_chat,
      from: ctx.from.id,
      session: ctx.session
    });

    // Skip if not in channel add mode or not from admin
    if (!ctx.session?.waitingForChannelAdd || !isAdmin(ctx.from.id)) {
      debug.log('Skipping message - not in channel add mode');
      return;
    }

    let channelId, title, username;

    // Handle forwarded messages
    if (ctx.message.forward_from_chat?.type === 'channel') {
      debug.log('Processing forwarded channel message');
      channelId = ctx.message.forward_from_chat.id.toString();
      title = ctx.message.forward_from_chat.title || "Unnamed Channel";
      username = ctx.message.forward_from_chat.username;
    } 
    // Handle direct text input
    else if (ctx.message.text) {
      const input = ctx.message.text.trim();
      debug.log('Processing channel ID input:', input);

      if (!/^(@\w+|-\d+)$/.test(input)) {
        await ctx.reply('⚠️ Please use @channelname or -1001234567890 format');
        return;
      }

      try {
        const chat = await ctx.telegram.getChat(input);
        if (chat.type !== 'channel') {
          await ctx.reply('⚠️ This is not a channel');
          return;
        }
        channelId = chat.id.toString();
        title = chat.title || "Unnamed Channel";
        username = chat.username;
      } catch (error) {
        debug.error('Channel lookup failed:', error);
        await ctx.reply('⚠️ Could not find channel. Make sure:\n1. Channel exists\n2. Bot is admin\n3. ID is correct');
        return;
      }
    } else {
      debug.log('Ignoring message - not a channel message');
      return;
    }

    // Verify bot is admin in channel
    try {
      debug.log('Checking bot admin status in channel:', channelId);
      const botMember = await ctx.telegram.getChatMember(channelId, ctx.botInfo.id);

      if (!['administrator', 'creator'].includes(botMember.status)) {
        await ctx.reply('❌ Bot must be admin with post permissions');
        return;
      }
    } catch (error) {
      debug.error('Admin check failed:', error);
      await ctx.reply('⚠️ Could not verify admin status. Please add bot as admin first');
      return;
    }

    // Check if channel exists
    const existing = await Channel.findOne({ channelId });
    if (existing) {
      await ctx.reply(`ℹ️ Channel "${title}" already exists`);
      return;
    }

    // Create invite link
    let inviteLink;
    try {
      inviteLink = await ctx.telegram.exportChatInviteLink(channelId);
    } catch (error) {
      debug.log('Could not get invite link, using fallback:', error);
      inviteLink = username ? `https://t.me/${username}` : `(No invite link available)`;
    }

    // Save to database
    try {
      debug.log('Saving channel to database:', { channelId, title });
      await Channel.create({
        channelId,
        title,
        username,
        inviteLink,
        addedBy: ctx.from.id
      });
    } catch (error) {
      debug.error('Database save failed:', error);
      await ctx.reply('⚠️ Error saving channel to database');
      return;
    }

    // Update in-memory list
    if (!CHANNEL_IDS.includes(channelId)) {
      CHANNEL_IDS.push(channelId);
    }

    // Success message
    await ctx.replyWithMarkdown(
      `✅ *Channel Added!*\n\n` +
      `*Name:* ${title}\n` +
      `*ID:* \`${channelId}\`\n` +
      `*Link:* ${inviteLink}`,
      Markup.inlineKeyboard([
        Markup.button.callback("🏠 Menu", "MAIN_MENU"),
        Markup.button.callback("🛠 Admin", "ADMIN_MENU")
      ])
    );

    debug.log('Successfully added channel:', channelId);

  } catch (error) {
    debug.error('Channel add process failed:', error);
    await ctx.reply('⚠️ An unexpected error occurred. Please try again');
  } finally {
    ctx.session.waitingForChannelAdd = false;
    debug.log('Channel add process completed. Session:', ctx.session);
  }
});

// 3. Add these critical debug commands:
bot.command('channel_debug', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const input = ctx.message.text.split(' ')[1];
  if (!input) return ctx.reply('Please provide channel ID (@name or -100ID)');

  try {
    const chat = await ctx.telegram.getChat(input);
    const botMember = await ctx.telegram.getChatMember(chat.id, ctx.botInfo.id);
    const inDb = await Channel.findOne({ channelId: chat.id.toString() });

    await ctx.replyWithMarkdown(
      `🔍 *Channel Debug*\n\n` +
      `*Title:* ${chat.title}\n` +
      `*ID:* \`${chat.id}\`\n` +
      `*Type:* ${chat.type}\n` +
      `*Username:* ${chat.username || 'None'}\n` +
      `*Bot Status:* ${botMember.status}\n` +
      `*In Database:* ${inDb ? '✅' : '❌'}\n` +
      `*In Memory:* ${CHANNEL_IDS.includes(chat.id.toString()) ? '✅' : '❌'}`
    );
  } catch (error) {
    await ctx.reply(`Error: ${error.message}`);
  }
});

bot.command('session_debug', (ctx) => {
  ctx.replyWithMarkdown(`Current session:\n\`\`\`json\n${JSON.stringify(ctx.session, null, 2)}\n\`\`\``);
});

bot.on('message', (ctx) => {
  console.log('Received message:', {
    text: ctx.message.text,
    forwardFrom: ctx.message.forward_from_chat,
    from: ctx.from.id,
    chat: ctx.chat.id
  });
});

// Add these temporary commands for debugging
bot.command('testadmin', async (ctx) => {
  const chatId = ctx.message.text.split(' ')[1];
  try {
    const member = await ctx.telegram.getChatMember(chatId, ctx.botInfo.id);
    ctx.reply(`Bot status in ${chatId}: ${member.status}`);
  } catch (error) {
    ctx.reply(`Error: ${error.message}`);
  }
});

bot.command('debugforward', (ctx) => {
  ctx.reply(`Last forwarded message: ${JSON.stringify(ctx.message.forward_from_chat)}`);
});

bot.command('checksession', (ctx) => {
  ctx.reply(`Current session: ${JSON.stringify(ctx.session)}`);
});

// List Channels
bot.action("LIST_CHANNELS", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const channels = await Channel.find().sort({ title: 1 });
  if (channels.length === 0) {
    await ctx.reply("ℹ️ No channels registered yet");
    return;
  }

  let message = "📺 *Registered Channels*\n\n";
  for (const channel of channels) {
    try {
      const isAdmin = await isBotAdminInChannel(channel.channelId);
      message += `- ${channel.title} \`${channel.channelId}\` ${isAdmin ? '✅' : '❌'}\n`;
    } catch {
      message += `- ${channel.title} \`${channel.channelId}\` ❌\n`;
    }
  }

  await ctx.replyWithMarkdown(message);
});

// Remove Channel
bot.action("REMOVE_CHANNEL", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const channels = await Channel.find().sort({ title: 1 });
  if (channels.length === 0) {
    await ctx.reply("ℹ️ No channels to remove");
    return;
  }

  const buttons = [];
  // Show 3 channels per row
  for (let i = 0; i < channels.length; i += 3) {
    const row = [];
    for (let j = 0; j < 3 && i + j < channels.length; j++) {
      row.push(
        Markup.button.callback(
          `❌ ${channels[i + j].title.substring(0, 15)}`,
          `REMOVE_CHANNEL_${channels[i + j]._id}`
        )
      );
    }
    buttons.push(row);
  }
  buttons.push([Markup.button.callback("🔙 Back", "ADMIN_CANCEL")]);

  await ctx.reply(
    "Select a channel to remove:",
    Markup.inlineKeyboard(buttons)
  );
});

// Handle Channel Removal
bot.action(/^REMOVE_CHANNEL_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const channelId = ctx.match[1];
  try {
    const channel = await Channel.findByIdAndDelete(channelId);
    if (!channel) {
      await ctx.reply("⚠️ Channel not found");
      return;
    }

    // Update in-memory list
    const index = CHANNEL_IDS.indexOf(channel.channelId);
    if (index > -1) {
      CHANNEL_IDS.splice(index, 1);
    }

    await ctx.replyWithMarkdown(
      `🗑 *Channel Removed*\n\n` +
      `*Name:* ${channel.title}\n` +
      `*ID:* \`${channel.channelId}\``
    );
  } catch (error) {
    console.error("Channel removal error:", error);
    await ctx.reply("⚠️ Error removing channel");
  } finally {
    await showAdminMenu(ctx);
  }
});


// Check if bot is admin in channel
const isBotAdminInChannel = async (channelId) => {
  try {
    const chatMember = await bot.telegram.getChatMember(channelId, bot.botInfo.id);
    return ['administrator', 'creator'].includes(chatMember.status);
  } catch (error) {
    console.error("Admin check error:", error);
    return false;
  }
};

// Refresh channel list from database
const refreshChannelList = async () => {
  try {
    const channels = await Channel.find({});
    CHANNEL_IDS = channels.map(c => c.channelId);
    console.log(`Refreshed channel list, ${CHANNEL_IDS.length} channels`);
  } catch (error) {
    console.error("Error refreshing channel list:", error);
  }
};

// Call this on bot startup
refreshChannelList();



// Broadcast execution
const executeBroadcast = async (ctx, target, content) => {
  let success = 0;
  let failed = 0;
  const broadcastMessages = [];

  try {
    await ctx.editMessageText("🔄 Sending broadcast...");

    // Broadcast to users
    if (target === 'users' || target === 'all') {
      const users = await User.find({});
      for (const user of users) {
        try {
          let message;
          if (content.text) {
            message = await ctx.telegram.sendMessage(user.userId, content.text);
          } else {
            if (content.type === "photo") {
              message = await ctx.telegram.sendPhoto(user.userId, content.fileId, { caption: content.caption });
            } else if (content.type === "video") {
              message = await ctx.telegram.sendVideo(user.userId, content.fileId, { caption: content.caption });
            } else if (content.type === "document") {
              message = await ctx.telegram.sendDocument(user.userId, content.fileId, { caption: content.caption });
            }
          }
          broadcastMessages.push({
            messageId: message.message_id,
            chatId: message.chat.id,
            content: content,
            targetType: 'user'
          });
          success++;
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          console.error(`Failed to send to user ${user.userId}:`, error);
          failed++;
        }
      }
    }

    // Broadcast to channels
    if (target === 'channels' || target === 'all') {
      const channels = await Channel.find();
      for (const channel of channels) {
        try {
          let message;
          if (content.text) {
            message = await ctx.telegram.sendMessage(channel.channelId, content.text);
          } else {
            if (content.type === "photo") {
              message = await ctx.telegram.sendPhoto(channel.channelId, content.fileId, { caption: content.caption });
            } else if (content.type === "video") {
              message = await ctx.telegram.sendVideo(channel.channelId, content.fileId, { caption: content.caption });
            } else if (content.type === "document") {
              message = await ctx.telegram.sendDocument(channel.channelId, content.fileId, { caption: content.caption });
            }
          }
          broadcastMessages.push({
            messageId: message.message_id,
            chatId: message.chat.id,
            content: content,
            targetType: 'channel'
          });
          success++;
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          console.error(`Failed to send to channel ${channel.channelId}:`, error);
          failed++;
        }
      }
    }

    // Save broadcast messages for possible deletion
    if (broadcastMessages.length > 0) {
      await Broadcast.insertMany(broadcastMessages);
    }

    await ctx.editMessageText(
      `✅ Broadcast completed\n\n` +
      `Success: ${success}\n` +
      `Failed: ${failed}`
    );

  } catch (error) {
    console.error("Broadcast error:", error);
    await ctx.reply("⚠️ Error during broadcast");
  }
};

// Text broadcast handlers
bot.action("CONFIRM_BROADCAST_TEXT_USERS", async (ctx) => {
  await executeBroadcast(ctx, 'users', { text: ctx.session.broadcastData.text });
});

bot.action("CONFIRM_BROADCAST_TEXT_CHANNELS", async (ctx) => {
  await executeBroadcast(ctx, 'channels', { text: ctx.session.broadcastData.text });
});

bot.action("CONFIRM_BROADCAST_TEXT_ALL", async (ctx) => {
  await executeBroadcast(ctx, 'all', { text: ctx.session.broadcastData.text });
});

// Media broadcast handlers
bot.action("CONFIRM_BROADCAST_MEDIA_USERS", async (ctx) => {
  await executeBroadcast(ctx, 'users', ctx.session.broadcastData);
});

bot.action("CONFIRM_BROADCAST_MEDIA_CHANNELS", async (ctx) => {
  await executeBroadcast(ctx, 'channels', ctx.session.broadcastData);
});

bot.action("CONFIRM_BROADCAST_MEDIA_ALL", async (ctx) => {
  await executeBroadcast(ctx, 'all', ctx.session.broadcastData);
});

// Delete broadcast handler
bot.action("ADMIN_DELETE_BROADCAST", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  clearMenuState(ctx);
  ctx.session.currentMenu = 'delete_broadcast';

  // Get last 10 broadcasts
  const broadcasts = await Broadcast.find().sort({ sentAt: -1 }).limit(10);

  if (broadcasts.length === 0) {
    await ctx.reply("No recent broadcasts found.");
    return;
  }

  const buttons = broadcasts.map(broadcast => [
    Markup.button.callback(
      `🗑 ${new Date(broadcast.sentAt).toLocaleString()} (${broadcast.targetType})`,
      `DELETE_BROADCAST_${broadcast._id}`
    )
  ]);

  buttons.push([Markup.button.callback("🔙 Back", "ADMIN_CANCEL")]);

  await ctx.reply(
    "Select a broadcast to delete:",
    Markup.inlineKeyboard(buttons)
  );
});

bot.action(/^DELETE_BROADCAST_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const broadcastId = ctx.match[1];
  const broadcast = await Broadcast.findById(broadcastId);

  if (!broadcast) {
    await ctx.reply("Broadcast not found.");
    return;
  }

  try {
    // Try to delete the message
    await ctx.telegram.deleteMessage(broadcast.chatId, broadcast.messageId);
    await Broadcast.deleteOne({ _id: broadcastId });
    await ctx.reply("✅ Broadcast message deleted successfully.");
  } catch (error) {
    console.error("Error deleting broadcast:", error);
    await ctx.reply("⚠️ Failed to delete broadcast message. It may have been already deleted.");
  }

  await showAdminMenu(ctx);
});

bot.action("ADMIN_CANCEL", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  clearMenuState(ctx);
  await ctx.deleteMessage();
  await showAdminMenu(ctx);
});

// Admin stats handler
bot.action("ADMIN_STATS", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  clearMenuState(ctx);
  ctx.session.currentMenu = 'stats';

  try {
    const userCount = await User.countDocuments();
    const premiumCount = await User.countDocuments({ isPremium: true });
    const videoCount = await Video.countDocuments();
    const groupAccessCount = await User.countDocuments({ hasPurchaseGroupAccess: true });
    const channelCount = await Channel.countDocuments();

    await ctx.reply(
      `📊 Bot Statistics:\n\n` +
      `👥 Total Users: ${userCount}\n` +
      `💎 Premium Users: ${premiumCount}\n` +
      `👑 Purchase Group Members: ${groupAccessCount}\n` +
      `🎥 Videos Available: ${videoCount}\n` +
      `📺 Registered Channels: ${channelCount}`
    );
  } catch (error) {
    console.error("Error getting stats:", error);
    await ctx.reply("⚠️ Error retrieving statistics");
  }
});

// Error handling
bot.catch((err, ctx) => {
  console.error(`⚠️ Error in ${ctx.updateType}:`, err);
  return ctx.reply("❌ An error occurred. Please try again.");
});

// Start bot
bot.launch()
.then(() => {
  console.log("🚀 Bot running successfully");
  // Initial cleanup and refresh
  cleanInactiveUsers();
  refreshChannelList();
  // Debug info
  debug.log('Bot started with config:', {
    admins,
    CHANNEL_IDS,
    botInfo: bot.botInfo
  });
  // Refresh channels every hour
  setInterval(refreshChannelList, 3600000);
})
.catch(err => console.error("❌ Bot failed to start:", err));

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
