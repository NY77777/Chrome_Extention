chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'NEW_CHAT_MESSAGE') {
    // Relay the message to the main video page tab
    if (sender.tab && sender.tab.id) {
       chrome.tabs.sendMessage(sender.tab.id, request);
    }
  }
});
