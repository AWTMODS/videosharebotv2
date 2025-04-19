require("dotenv").config();
const { Telegraf, Markup, session } = require("telegraf");
const mongoose = require("mongoose");
const schedule = require("node-schedule");

// Initialize bot with session middleware
const bot = new Telegraf(process.env.BOT_TOKEN);

// Session configuration with default values
bot.use(session({
  defaultSession: () => ({
    waitingForBroadcast: null,
    waitingForUpload: false,
    broadcastData: null,
    waitingForPurchaseProof: false,
    waitingForPremiumProof: false
  })
}));

// Suppress punycode warning
process.removeAllListeners('warning');

// Configuration
const admins = process.env.ADMINS.split(',').map(id => id.trim());
const VIDEO_BATCH_SIZE = parseInt(process.env.VIDEO_BATCH_SIZE) || 10;
const MESSAGE_DELETE_MINUTES = parseInt(process.env.MESSAGE_DELETE_MINUTES) || 30;
const PURCHASE_GROUP_LINK = process.env.PURCHASE_GROUP_LINK || "https://t.me/yourpurchasegroup";
const PURCHASE_GROUP_PRICE = process.env.PURCHASE_GROUP_PRICE || "₹99";
const GROUP_LINK = process.env.GROUP_LINK || "https://t.me/yourgroup";

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
});

const User = mongoose.model("User", userSchema);
const Video = mongoose.model("Video", videoSchema);

// Helper functions
const isAdmin = (userId) => admins.includes(userId.toString());

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

const sendUPIDetails = async (ctx, isPurchaseGroup = false) => {
  ctx.session = ctx.session || {};

  const caption = isPurchaseGroup 
    ? `💳 *Purchase Group Access (${PURCHASE_GROUP_PRICE})*\n\n1. Scan the QR or copy UPI ID\n2. Send payment proof to verify`
    : `💳 *Premium Subscription*\n\n1. Scan the QR or copy UPI ID\n2. Send payment proof to verify`;

  const buttons = [
    [Markup.button.callback("📋 Copy UPI ID", "COPY_UPI")],
    [Markup.button.callback("🔙 Back", "MAIN_MENU")]
  ];

  await ctx.replyWithPhoto({ 
    source: isPurchaseGroup ? "./purchase_qr.png" : "./premium_qr.png" 
  }, {
    caption,
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons)
  });

  if (isPurchaseGroup) {
    ctx.session.waitingForPurchaseProof = true;
    ctx.session.waitingForPremiumProof = false;
  } else {
    ctx.session.waitingForPremiumProof = true;
    ctx.session.waitingForPurchaseProof = false;
  }
};

const sendPurchaseGroupDetails = async (ctx) => {
  const user = await User.findOne({ userId: ctx.from.id });

  if (user && user.hasPurchaseGroupAccess) {
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

const sendVideoBatch = async (ctx, user) => {
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

    await showMainMenu(ctx);

  } catch (error) {
    console.error("Error sending videos:", error);
    ctx.reply("⚠️ Error sending videos. Please try again.");
  }
};

const showMainMenu = async (ctx) => {
  const buttons = [
    [Markup.button.callback(`📥 GET ${VIDEO_BATCH_SIZE} VIDEOS`, "GET_VIDEO")],
    [Markup.button.callback("💳 SUBSCRIBE", "SUBSCRIBE")],
    [Markup.button.callback("👥 PURCHASE GROUP", "PURCHASE_GROUP"),
     Markup.button.callback("🆕 DEMO", "DEMO")]
  ];

  await ctx.reply("🎬 MAIN MENU", Markup.inlineKeyboard(buttons));
};

const showAdminMenu = async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const buttons = [
    [Markup.button.callback("📢 Broadcast Message", "ADMIN_BROADCAST_TEXT")],
    [Markup.button.callback("📷 Broadcast Media", "ADMIN_BROADCAST_MEDIA")],
    [Markup.button.callback("🎥 Upload Media", "ADMIN_UPLOAD_MEDIA")],
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
  await sendVideoBatch(ctx, user);
});

bot.action("SUBSCRIBE", async (ctx) => {
  await sendUPIDetails(ctx, false);
});

bot.action("PURCHASE_GROUP", sendPurchaseGroupDetails);
bot.action("PURCHASE_GROUP_PAY", async (ctx) => {
  await sendUPIDetails(ctx, true);
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

  if (ctx.session.waitingForPurchaseProof) {
    await forwardPaymentToAdmin(ctx, true);
    delete ctx.session.waitingForPurchaseProof;
  } else if (ctx.session.waitingForPremiumProof) {
    await forwardPaymentToAdmin(ctx, false);
    delete ctx.session.waitingForPremiumProof;
  }
});

async function forwardPaymentToAdmin(ctx, isPurchaseGroup) {
  const userId = ctx.from.id;
  const caption = isPurchaseGroup
    ? `🧾 Purchase Group Payment from [${ctx.from.first_name}](tg://user?id=${userId})`
    : `🧾 Premium Payment from [${ctx.from.first_name}](tg://user?id=${userId})`;

  const buttons = Markup.inlineKeyboard([
    Markup.button.callback("✅ Verify", `VERIFY_${userId}_${isPurchaseGroup ? 'GROUP' : 'PREMIUM'}`),
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
  const verifyType = ctx.match[2];

  if (verifyType === 'GROUP') {
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

  ctx.session = ctx.session || {};
  ctx.session.waitingForBroadcast = "text";

  await ctx.reply("📢 Enter the broadcast message:", 
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
      [Markup.button.callback("✅ Confirm Send", "CONFIRM_BROADCAST_TEXT")],
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

  ctx.session = ctx.session || {};
  ctx.session.waitingForBroadcast = "media";

  await ctx.reply("📷 Send media to broadcast (photo/video/document):", 
    Markup.inlineKeyboard([
      Markup.button.callback("❌ Cancel", "ADMIN_CANCEL")
    ])
  );
});

bot.on(["photo", "video", "document"], async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  ctx.session = ctx.session || {};

  if (ctx.session.waitingForBroadcast === "media") {
    const fileId = ctx.message.photo?.[0]?.file_id 
                 || ctx.message.video?.file_id 
                 || ctx.message.document?.file_id;

    const buttons = [
      [Markup.button.callback("✅ Confirm Send", "CONFIRM_BROADCAST_MEDIA")],
      [Markup.button.callback("❌ Cancel", "ADMIN_CANCEL")]
    ];

    await ctx.reply(
      `📢 Media Broadcast Preview\n\nCaption: ${ctx.message.caption || "None"}`,
      Markup.inlineKeyboard(buttons)
    );

    ctx.session.broadcastData = {
      fileId,
      type: ctx.message.photo ? "photo" 
           : ctx.message.video ? "video" 
           : "document",
      caption: ctx.message.caption || ""
    };
    ctx.session.waitingForBroadcast = null;
  }
});

bot.action(/^CONFIRM_BROADCAST_(TEXT|MEDIA)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const type = ctx.match[1];
  const { text, fileId, caption, type: mediaType } = ctx.session.broadcastData || {};
  const users = await User.find({});
  let success = 0;

  try {
    await ctx.editMessageText("🔄 Sending to all users...");

    for (const user of users) {
      try {
        if (type === "TEXT") {
          await ctx.telegram.sendMessage(user.userId, text);
        } else {
          if (mediaType === "photo") {
            await ctx.telegram.sendPhoto(user.userId, fileId, { caption });
          } else if (mediaType === "video") {
            await ctx.telegram.sendVideo(user.userId, fileId, { caption });
          } else if (mediaType === "document") {
            await ctx.telegram.sendDocument(user.userId, fileId, { caption });
          }
        }
        success++;
        await new Promise(resolve => setTimeout(resolve, 100)); // Rate limiting
      } catch (error) {
        console.error(`Failed to send to user ${user.userId}:`, error);
      }
    }

    await ctx.editMessageText(
      `✅ Broadcast completed\n\n` +
      `Success: ${success}/${users.length} users\n` +
      `Failed: ${users.length - success} users`
    );

  } catch (error) {
    console.error("Broadcast error:", error);
    await ctx.reply("⚠️ Error during broadcast");
  } finally {
    delete ctx.session.broadcastData;
  }
});

bot.action("ADMIN_CANCEL", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  ctx.session = ctx.session || {};
  delete ctx.session.waitingForBroadcast;
  delete ctx.session.broadcastData;
  await ctx.deleteMessage();
  await showAdminMenu(ctx);
});

// Admin upload handler
bot.action("ADMIN_UPLOAD_MEDIA", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  ctx.session = ctx.session || {};
  ctx.session.waitingForUpload = true;

  await ctx.reply("🎥 Send media to add to the database:", 
    Markup.inlineKeyboard([
      Markup.button.callback("❌ Cancel", "ADMIN_CANCEL")
    ])
  );
});

bot.on(["photo", "video", "document"], async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  ctx.session = ctx.session || {};

  if (ctx.session.waitingForUpload) {
    const fileId = ctx.message.photo?.[0]?.file_id 
                 || ctx.message.video?.file_id 
                 || ctx.message.document?.file_id;

    const exists = await Video.findOne({ fileId });
    if (exists) {
      await ctx.reply("⚠️ Media already exists in database.");
    } else {
      await Video.create({ fileId });
      await ctx.reply("✅ Media added to database!");
    }
    delete ctx.session.waitingForUpload;
  }
});

// Admin stats handler
bot.action("ADMIN_STATS", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  try {
    const userCount = await User.countDocuments();
    const premiumCount = await User.countDocuments({ isPremium: true });
    const videoCount = await Video.countDocuments();
    const groupAccessCount = await User.countDocuments({ hasPurchaseGroupAccess: true });

    await ctx.reply(
      `📊 Bot Statistics:\n\n` +
      `👥 Total Users: ${userCount}\n` +
      `💎 Premium Users: ${premiumCount}\n` +
      `👑 Purchase Group Members: ${groupAccessCount}\n` +
      `🎥 Videos Available: ${videoCount}`
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
  .then(() => console.log("🚀 Bot running successfully"))
  .catch(err => console.error("❌ Bot failed to start:", err));

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
