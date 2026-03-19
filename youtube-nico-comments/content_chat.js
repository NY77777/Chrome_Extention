function observeChat() {
  const chatContainer = document.querySelector('#items.yt-live-chat-item-list-renderer');
  if (!chatContainer) {
    setTimeout(observeChat, 1000);
    return;
  }

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeName === 'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER' || node.nodeName === 'YT-LIVE-CHAT-PAID-MESSAGE-RENDERER') {
          const messageSpan = node.querySelector('#message');
          const authorSpan = node.querySelector('#author-name');
          if (messageSpan) {
            let messageText = '';
            messageSpan.childNodes.forEach(child => {
               if (child.nodeType === Node.TEXT_NODE) {
                  messageText += child.textContent;
               } else if (child.nodeName === 'IMG' && child.alt) {
                  // Capture emotes via alt text
                  messageText += child.alt;
               }
            });
            
            const authorText = authorSpan ? authorSpan.textContent : 'Unknown';
            const messageId = node.id || Math.random().toString();
            const memberBadge = node.querySelector('yt-live-chat-author-badge-renderer[type="member"]');

            let overrideColor = null;
            if (node.nodeName === 'YT-LIVE-CHAT-PAID-MESSAGE-RENDERER') {
              const styles = getComputedStyle(node);
              overrideColor = styles.getPropertyValue('--yt-live-chat-paid-message-header-background-color') || 
                              styles.getPropertyValue('--yt-live-chat-paid-message-primary-color') || 
                              styles.getPropertyValue('--yt-live-chat-paid-message-body-background-color');
              if (overrideColor) overrideColor = overrideColor.trim();
            }

            chrome.runtime.sendMessage({
              type: 'NEW_CHAT_MESSAGE',
              id: messageId,
              message: messageText.trim(),
              author: authorText.trim(),
              isMember: !!memberBadge,
              overrideColor: overrideColor
            });
          }
        }
      });
    });
  });

  observer.observe(chatContainer, { childList: true });
}

// Start attempting to observe the chat DOM
observeChat();
