import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import {
  createUser,
  getUserByTelegramId,
  getUserById,
  getUserByTelegramName,
  createTransaction,
  confirmTransaction
} from './core.js';

dotenv.config();
const token = process.env.TELEGRAM_TOKEN;
const GROUP_IDS = process.env.ESCROW_GROUP_IDS.split(',').map(id => id.trim());
if (!token || !GROUP_IDS.length) {
  console.error('Missing TELEGRAM_TOKEN or ESCROW_GROUP_IDS');
  process.exit(1);
}
const bot = new TelegramBot(token, { polling: true });

// Track group usage and invite links
const groupStatus = new Map(GROUP_IDS.map(gid => [gid, null]));
const inviteMap = new Map();
const groupTimeouts = new Map(); // Track group cleanup timeouts
const groupMembers = new Map(); // Track seller and buyer in each group
// NEW: Track allowed participants per group
const groupAllowedParticipants = new Map(); // { groupId: { initiator: telegramId, partner: telegramId } }

function findFreeGroup() {
  for (const gid of GROUP_IDS) {
    if (groupStatus.get(gid) === null) return gid;
  }
  return null;
}

// Helper function to check if chat is private
function isPrivateChat(chatType) {
  return chatType === 'private';
}

// Helper function to validate if user is allowed in this group
function isUserAllowedInGroup(groupId, telegramId) {
  const allowedParticipants = groupAllowedParticipants.get(groupId);
  if (!allowedParticipants) return false;
  
  return allowedParticipants.initiator === telegramId || 
         allowedParticipants.partner === telegramId;
}

// Helper function to clean up group after transaction
async function cleanupGroup(groupId, buyerTelegramId = null, sellerTelegramId = null) {
  try {
    console.log(`Starting cleanup for group ${groupId}`);
    
    // Send warning message first
    await bot.sendMessage(groupId, '⚠️ Transaksi telah selesai. Participant akan otomatis dikeluarkan dari grup dalam 10 detik.');
    await bot.sendMessage(groupId, '🔒 Grup akan ditutup. Terima kasih telah menggunakan layanan escrow kami.');
    
    // Set timeout for cleanup
    const timeoutId = setTimeout(async () => {
      try {
        console.log(`Executing cleanup for group ${groupId}`);
        
        // Kick buyer and seller from group if their telegram IDs are provided
        const membersToKick = [];
        if (buyerTelegramId) membersToKick.push(buyerTelegramId);
        if (sellerTelegramId) membersToKick.push(sellerTelegramId);
        
        // Try to get members from groupMembers map if not provided
        if (membersToKick.length === 0 && groupMembers.has(groupId)) {
          const storedMembers = groupMembers.get(groupId);
          if (storedMembers.buyer) membersToKick.push(storedMembers.buyer);
          if (storedMembers.seller) membersToKick.push(storedMembers.seller);
        }
        
        // Kick members
        for (const telegramId of membersToKick) {
          try {
            await bot.banChatMember(groupId, telegramId);
            console.log(`Kicked user ${telegramId} from group ${groupId}`);
            
            // Immediately unban them so they can potentially join other groups later
            await bot.unbanChatMember(groupId, telegramId);
            console.log(`Unbanned user ${telegramId} from group ${groupId}`);
          } catch (kickError) {
            console.log(`Could not kick user ${telegramId} from group ${groupId}:`, kickError.message);
          }
        }
        
        // Find invite link data for this group
        const userEntry = Array.from(inviteMap.entries()).find(([_, data]) => data.group_id === groupId);
        const inviteLink = userEntry?.[1]?.invite_link;
        
        // Try to revoke invite link only if it exists and is valid
        if (inviteLink && inviteLink.trim() !== '') {
          try {
            await bot.revokeChatInviteLink(groupId, inviteLink);
            console.log(`Invite link revoked for group ${groupId}`);
          } catch (revokeError) {
            console.log(`Could not revoke invite link for group ${groupId}:`, revokeError.message);
            // Continue with cleanup even if revoking fails
          }
        } else {
          console.log(`No valid invite link found for group ${groupId}, skipping revoke`);
        }
        
        // Send final message
        try {
          await bot.sendMessage(groupId, '🔒 Grup telah dibersihkan. Terima kasih telah menggunakan layanan escrow kami.');
        } catch (msgError) {
          console.log(`Could not send final message to group ${groupId}:`, msgError.message);
        }
        
        // Clean up tracking data
        groupStatus.set(groupId, null);
        groupMembers.delete(groupId);
        groupAllowedParticipants.delete(groupId); // NEW: Clean up allowed participants
        if (userEntry) {
          inviteMap.delete(userEntry[0]);
        }
        groupTimeouts.delete(groupId);
        
        console.log(`Group ${groupId} cleanup completed successfully`);
        
      } catch (cleanupError) {
        console.error('Error during group cleanup:', cleanupError);
        
        // Even if cleanup fails, reset the group status so it can be reused
        groupStatus.set(groupId, null);
        groupMembers.delete(groupId);
        groupAllowedParticipants.delete(groupId); // NEW: Clean up allowed participants
        const userEntry = Array.from(inviteMap.entries()).find(([_, data]) => data.group_id === groupId);
        if (userEntry) {
          inviteMap.delete(userEntry[0]);
        }
        groupTimeouts.delete(groupId);
      }
    }, 10000); // 10 seconds
    
    // Store timeout ID for potential cancellation
    groupTimeouts.set(groupId, timeoutId);
    
  } catch (error) {
    console.error('Error in cleanupGroup setup:', error);
  }
}

// Helper function to check if chat is group
function isGroupChat(chatType) {
  return chatType === 'group' || chatType === 'supergroup';
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const chatType = msg.chat.type;
  const senderId = msg.from.id;
  const text = (msg.text || '').trim();

  try {
    if (text === '/register') {
      // Only allowed in private chat
      if (!isPrivateChat(chatType)) {
        return bot.sendMessage(chatId, '❌ Command /register hanya bisa digunakan di chat pribadi dengan bot.');
      }

      // Check if user already registered
      try {
        const existingUser = await getUserByTelegramId(senderId);
        if (existingUser) {
          return bot.sendMessage(chatId, '⚠️ Anda sudah terdaftar dalam sistem.');
        }
      } catch (err) {
        // User doesn't exist, continue with registration
      }

      const username = msg.from.username || `user${senderId}`;
      await createUser(senderId, username);
      return bot.sendMessage(chatId, `✅ Berhasil terdaftar sebagai ${username}`);

    } else if (text === '/balance') {
      // Only allowed in private chat
      if (!isPrivateChat(chatType)) {
        return bot.sendMessage(chatId, '❌ Command /balance hanya bisa digunakan di chat pribadi dengan bot.');
      }

      const user = await getUserByTelegramId(senderId);
      return bot.sendMessage(chatId, `💰 Saldo Anda: ${user.balance}`);

    } else if (text.startsWith('/pay ')) {
      // Only allowed in group chat
      if (!isGroupChat(chatType)) {
        return bot.sendMessage(chatId, '❌ Command /pay hanya bisa digunakan di dalam grup.');
      }

      const groupId = chatId.toString();
      
      // NEW: Check if this is one of our escrow groups
      if (!GROUP_IDS.includes(groupId)) {
        return bot.sendMessage(chatId, '❌ Command /pay hanya bisa digunakan di grup escrow resmi.');
      }

      // NEW: Check if sender is allowed in this group
      if (!isUserAllowedInGroup(groupId, senderId)) {
        return bot.sendMessage(chatId, '❌ Anda tidak diizinkan melakukan transaksi di grup ini.');
      }

      // /pay <userId> <amount>
      const parts = text.split(' ');
      const targetId = parts[1];
      const amount = parseFloat(parts[2]);
      // if (isNaN(targetId) || isNaN(amount) || amount <= 0) {
      //   throw new Error('Usage: /pay <userId> <amount>');
      // }

      const buyer = await getUserByTelegramId(senderId);
      const seller = await getUserByTelegramName(targetId);

      // NEW: Check if seller is allowed in this group
      if (!isUserAllowedInGroup(groupId, seller.telegramId)) {
        return bot.sendMessage(chatId, '❌ User yang Anda tuju tidak diizinkan untuk menerima pembayaran di grup ini.');
      }

      // NEW: Additional validation - make sure buyer and seller are different people
      if (buyer.telegramId === seller.telegramId) {
        return bot.sendMessage(chatId, '❌ Anda tidak bisa membayar ke diri sendiri.');
      }

      const tx = await createTransaction(buyer.id, seller.id, amount);
      
      // Store buyer and seller telegram IDs for this group
      groupMembers.set(groupId, {
        buyer: buyer.telegramId,
        seller: seller.telegramId,
        transactionId: tx.id
      });
      
      // Reply in the group where command was executed
      await bot.sendMessage(chatId,
        `✅ Payment request created: Transaction ID=${tx.id}, amount=${tx.amount}.`);
      await bot.sendMessage(chatId,
        `ℹ️ Use /confirm <transactionId> to end this transaction.`);
      
      // Notify seller privately
      await bot.sendMessage(seller.telegramId,
        `💸 New payment request: ID=${tx.id}, from ${buyer.name}, amount=${tx.amount}.`);
      return;

    } else if (text.startsWith('/confirm ')) {
      // Only allowed in group chat
      if (!isGroupChat(chatType)) {
        return bot.sendMessage(chatId, '❌ Command /confirm hanya bisa digunakan di dalam grup.');
      }

      const groupId = chatId.toString();
      
      // NEW: Check if this is one of our escrow groups
      if (!GROUP_IDS.includes(groupId)) {
        return bot.sendMessage(chatId, '❌ Command /confirm hanya bisa digunakan di grup escrow resmi.');
      }

      // NEW: Check if sender is allowed in this group
      if (!isUserAllowedInGroup(groupId, senderId)) {
        return bot.sendMessage(chatId, '❌ Anda tidak diizinkan melakukan konfirmasi di grup ini.');
      }

      // /confirm <txId>
      const parts = text.split(' ');
      const txId = parseInt(parts[1], 10);
      if (isNaN(txId)) throw new Error('Usage: /confirm <transactionId>');

      const buyer = await getUserByTelegramId(senderId);
      const tx = await confirmTransaction(txId, buyer.id);

      // Reply in the group where command was executed
      await bot.sendMessage(chatId,
        `✅ Transaction ID=${tx.id} confirmed. Funds released (${tx.amount}).`);
      
      // Notify seller privately
      const seller = await getUserById(tx.sellerId);
      await bot.sendMessage(seller.telegramId,
        `💰 You received ${tx.amount} for Transaction ID=${tx.id}.`);

      // Start group cleanup process with buyer and seller info
      if (GROUP_IDS.includes(groupId)) {
        console.log(`Starting cleanup for group ${groupId} after transaction completion`);
        await cleanupGroup(groupId, buyer.telegramId, seller.telegramId);
      }
      
      return;

    } else if (text.startsWith('/createtransaction ')) {
      // Only allowed in private chat
      if (!isPrivateChat(chatType)) {
        return bot.sendMessage(chatId, '❌ Command /createtransaction hanya bisa digunakan di chat pribadi dengan bot.');
      }

      const parts = text.split(' ');
      const targetId = parts[1];

      console.log('isi target :', targetId);
      console.log('isi parts :', parts);

      const initiator = await getUserByTelegramId(senderId);
      const partner = await getUserByTelegramName(targetId);
      console.log('isi partner : ', partner)
      
      // NEW: Make sure initiator and partner are different people
      if (initiator.telegramId === partner.telegramId) {
        return bot.sendMessage(chatId, '❌ Anda tidak bisa membuat transaksi dengan diri sendiri.');
      }
      
      const freeGroup = findFreeGroup();

      if (!freeGroup) throw new Error('All groups are busy, please try later.');

      const invite = await bot.createChatInviteLink(freeGroup, { member_limit: 2 });

      groupStatus.set(freeGroup, senderId);
      inviteMap.set(senderId, { group_id: freeGroup, invite_link: invite.invite_link });
      
      // NEW: Store allowed participants for this group
      groupAllowedParticipants.set(freeGroup, {
        initiator: initiator.telegramId,
        partner: partner.telegramId
      });

      await bot.sendMessage(
        partner.telegramId,
        `📩 Chat invite from ${initiator.name}: ${invite.invite_link}`
      );

      return bot.sendMessage(chatId, `🔗 Invite link: ${invite.invite_link}`);

    } else if (text === '/help') {
      let helpMessage = '';
      
      if (isPrivateChat(chatType)) {
        helpMessage = '📋 **Commands untuk Chat Pribadi:**\n\n' +
          '🔐 `/register` - Daftar ke sistem\n' +
          '💰 `/balance` - Cek saldo Anda\n' +
          '🤝 `/createtransaction <userId>` - Buat room transaksi\n' +
          '❓ `/help` - Tampilkan bantuan';
      } else if (isGroupChat(chatType)) {
        helpMessage = '📋 **Commands untuk Grup:**\n\n' +
          '💸 `/pay <userId> <amount>` - Buat pembayaran\n' +
          '✅ `/confirm <transactionId>` - Konfirmasi transaksi\n' +
          '❓ `/help` - Tampilkan bantuan';
      }
      
      return bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
      
    } else if (text.startsWith('/')) {
      let errorMessage = '';
      
      if (isPrivateChat(chatType)) {
        errorMessage = '❌ Command tidak dikenal. Ketik /help untuk melihat daftar command yang tersedia di chat pribadi.';
      } else if (isGroupChat(chatType)) {
        errorMessage = '❌ Command tidak dikenal. Ketik /help untuk melihat daftar command yang tersedia di grup.';
      }
      
      return bot.sendMessage(chatId, errorMessage);
    }
  } catch (err) {
    return bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// Handle when users join/leave groups
bot.on('new_chat_members', async (msg) => {
  const chatId = msg.chat.id;
  console.log(`New members joined group ${chatId}`);
});

bot.on('left_chat_member', async (msg) => {
  const chatId = msg.chat.id;
  console.log(`Member left group ${chatId}`);
  
  // Check if this is one of our escrow groups and if it's empty
  const groupId = chatId.toString();
  if (GROUP_IDS.includes(groupId)) {
    try {
      const memberCount = await bot.getChatMemberCount(chatId);
      // If only the bot is left (memberCount = 1), clean up
      if (memberCount <= 1) {
        console.log(`Group ${groupId} is now empty, cleaning up...`);
        groupStatus.set(groupId, null);
        groupMembers.delete(groupId);
        groupAllowedParticipants.delete(groupId); // NEW: Clean up allowed participants
        const userEntry = Array.from(inviteMap.entries()).find(([_, data]) => data.group_id === groupId);
        if (userEntry) {
          inviteMap.delete(userEntry[0]);
        }
        // Clear any pending timeouts
        if (groupTimeouts.has(groupId)) {
          clearTimeout(groupTimeouts.get(groupId));
          groupTimeouts.delete(groupId);
        }
      }
    } catch (error) {
      console.error('Error checking group member count:', error);
    }
  }
});

export { bot };