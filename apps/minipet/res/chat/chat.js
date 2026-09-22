/* chat.js — QWebChannel 桥接 + 消息渲染 */
'use strict';

marked.setOptions({ breaks: true, gfm: true });

const Chat = (() => {
  let bridge = null;
  let streamBubble = null; // 当前流式气泡的 content div
  let streamId = null;
  let streamText = '';
  let _ctxMenu = null;
  let _selectionCopyButton = null;
  let _selectionCopyText = '';

  function _copyToClipboard(text) {
    // WebEngine 的 navigator.clipboard 需要权限且默认被拒，优先走 Qt 桥
    if (typeof bridge !== 'undefined' && bridge && bridge.copyText) {
      bridge.copyText(text);
      return true;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    return false;
  }

  /* ─── 初始化 QWebChannel ─── */
  function init() {
    _initSelectionCopy();
    if (typeof QWebChannel === 'undefined') return;
    new QWebChannel(qt.webChannelTransport, ch => {
      bridge = ch.objects.bridge;
    });
  }

  function _initSelectionCopy() {
    if (_selectionCopyButton) return;
    const button = document.createElement('button');
    button.id = 'chat-selection-copy';
    button.textContent = '复制';
    button.hidden = true;
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      const text = _selectionCopyText;
      if (!text) { _hideSelectionCopy(true); return; }
      const ok = _copyToClipboard(text);
      button.textContent = ok ? '已复制' : '复制失败';
      setTimeout(() => {
        button.textContent = '复制';
        _hideSelectionCopy(true);
      }, 900);
    });
    document.body.appendChild(button);
    _selectionCopyButton = button;
    document.addEventListener('selectionchange', _syncSelectionCopy);
    document.addEventListener('mouseup', _syncSelectionCopy);
    document.addEventListener('pointerdown', event => {
      if (event.target !== button) _hideSelectionCopy(false);
    }, true);
    document.addEventListener('contextmenu', () => _hideSelectionCopy(true), true);
    document.addEventListener('scroll', () => _hideSelectionCopy(false), true);
  }

  function _getCopyableSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
    const text = selection.toString();
    if (!text.trim()) return null;
    const range = selection.getRangeAt(0);
    const messages = document.getElementById('messages');
    const start = range.startContainer.parentElement;
    const end = range.endContainer.parentElement;
    if (!messages || !start || !end || !messages.contains(range.commonAncestorContainer)) return null;
    const allowed = node => node.closest && node.closest('.bubble-content, .quote-block');
    if (!allowed(start) || !allowed(end)) return null;
    return { range, text };
  }

  function _syncSelectionCopy() {
    const selected = _getCopyableSelection();
    if (!selected) {
      _hideSelectionCopy(false);
      return;
    }
    _selectionCopyText = selected.text;
    const rect = selected.range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const button = _selectionCopyButton;
    button.hidden = false;
    const left = Math.max(6, Math.min(rect.left + rect.width / 2 - button.offsetWidth / 2, window.innerWidth - button.offsetWidth - 6));
    const top = rect.top > button.offsetHeight + 8 ? rect.top - button.offsetHeight - 8 : rect.bottom + 8;
    button.style.left = left + 'px';
    button.style.top = Math.max(6, Math.min(top, window.innerHeight - button.offsetHeight - 6)) + 'px';
  }

  function _hideSelectionCopy(clearSelection) {
    if (_selectionCopyButton) _selectionCopyButton.hidden = true;
    _selectionCopyText = '';
    if (clearSelection) window.getSelection().removeAllRanges();
  }

  /* ─── 从 Python 添加完整消息 ─── */
  function appendMessage(msg) {
    // 如果有正在流式输出的气泡先结束它
    _hideSelectionCopy(true);
    if (streamBubble) _finalizeStream();
    const row = _buildRow(msg);
    document.getElementById('messages').appendChild(row);
    scrollToBottom();
  }

  /* ─── 流式追加 delta ─── */
  function startStream(msgOrId, role, name, avatarSrc) {
    _hideSelectionCopy(true);
    if (streamBubble) _finalizeStream();
    // 兼容对象调用 Chat.startStream({id,role,name,avatar}) 和旧式四参数调用
    const msg = (msgOrId && typeof msgOrId === 'object')
      ? msgOrId
      : { id: msgOrId, role, name, avatar: avatarSrc };
    streamId = msg.id;
    streamText = '';
    const row = _buildRow({ ...msg, content: [{ type: 'text', text: '' }] });
    row.dataset.streamId = streamId;
    document.getElementById('messages').appendChild(row);
    streamBubble = row.querySelector('.bubble-content');
    streamBubble.classList.add('typing-cursor');
    scrollToBottom();
  }

  function appendDelta(id, delta) {
    if (streamId !== id || !streamBubble) return;
    _hideSelectionCopy(true);
    streamText += delta;
    streamBubble.innerHTML = marked.parse(streamText);
    _bindCodeCopy(streamBubble);
    scrollToBottom();
  }

  function endStream(id, finalText) {
    if (streamId !== id || !streamBubble) return;
    _hideSelectionCopy(true);
    streamBubble.classList.remove('typing-cursor');
    if (finalText !== undefined) {
      streamBubble.innerHTML = marked.parse(finalText);
      _bindCodeCopy(streamBubble);
    }
    streamBubble = null;
    streamId = null;
    streamText = '';
    scrollToBottom();
  }

  function _finalizeStream() {
    if (!streamBubble) return;
    _hideSelectionCopy(true);
    streamBubble.classList.remove('typing-cursor');
    streamBubble = null;
    streamId = null;
    streamText = '';
  }

  function _buildRow(msg) {
    const isUser = msg.role === 'user';
    const row = document.createElement('div');
    row.className = 'msg-row' + (isUser ? ' user' : '');

    // 头像
    const av = document.createElement('div');
    av.className = 'avatar ' + (isUser ? 'user-av' : 'pet-av');
    if (msg.avatar) {
      const img = document.createElement('img');
      img.src = msg.avatar;
      img.onerror = () => { av.textContent = (msg.name || (isUser ? '我' : '宠'))[0]; };
      av.appendChild(img);
    } else {
      av.textContent = (msg.name || (isUser ? '我' : '宠'))[0];
    }

    // 消息体
    const body = document.createElement('div');
    body.className = 'msg-body';
    const nameEl = document.createElement('div');
    nameEl.className = 'msg-name';
    nameEl.textContent = msg.name || (isUser ? '我' : '宠物');
    body.appendChild(nameEl);

    const blocks = msg.content || [];
    const hasMixed = blocks.length > 1;
    if (hasMixed) {
      // 多 block 合并到一个气泡
      const bubble = document.createElement('div');
      bubble.className = 'bubble ' + (isUser ? 'user-bubble' : 'pet-bubble');
      for (const block of blocks) {
        bubble.appendChild(_buildBlockInner(block, isUser));
      }
      body.appendChild(bubble);
    } else {
      for (const block of blocks) {
        body.appendChild(_buildBlock(block, isUser));
      }
    }

    if (isUser) {
      row.appendChild(body);
      row.appendChild(av);
    } else {
      row.appendChild(av);
      row.appendChild(body);
    }
    return row;
  }

  // 气泡内部元素（不带外层 bubble div）
  function _buildBlockInner(block, isUser) {
    const t = block.type;
    if (t === 'text') {
      const content = document.createElement('div');
      content.className = 'bubble-content';
      content.innerHTML = marked.parse(block.text || ' ');
      _bindCodeCopy(content);
      return content;
    }
    if (t === 'image') {
      const img = document.createElement('img');
      img.className = 'chat-img';
      img.src = block.src || '';
      img.alt = block.alt || '图片';
      img.onclick = () => openLightbox(block.src);
      return img;
    }
    return document.createElement('div');
  }

  function _buildBlock(block, isUser) {
    const t = block.type;
    if (t === 'text') {
      const bubble = document.createElement('div');
      bubble.className = 'bubble ' + (isUser ? 'user-bubble' : 'pet-bubble');
      // 引用块（飞书风格）
      if (block.quote) {
        const qb = document.createElement('div');
        qb.className = 'quote-block';
        qb.textContent = block.quote;
        bubble.appendChild(qb);
      }
      const content = document.createElement('div');
      content.className = 'bubble-content';
      content.innerHTML = marked.parse(block.text || ' ');
      _bindCodeCopy(content);
      bubble.appendChild(content);
      if (!isUser) {
        bubble.addEventListener('contextmenu', e => { e.preventDefault(); _showCtxMenu(e, bubble); });
      }
      return bubble;
    }
    if (t === 'image') {
      const bubble = document.createElement('div');
      bubble.className = 'bubble ' + (isUser ? 'user-bubble' : 'pet-bubble');
      const img = document.createElement('img');
      img.className = 'chat-img';
      img.src = block.src || '';
      img.alt = block.alt || '图片';
      img.onclick = () => openLightbox(block.src);
      bubble.appendChild(img);
      return bubble;
    }
    if (t === 'code') {
      const bubble = document.createElement('div');
      bubble.className = 'bubble ' + (isUser ? 'user-bubble' : 'pet-bubble');
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = block.text || '';
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = '复制';
      btn.onclick = () => _copy(block.text || '', btn);
      pre.appendChild(btn);
      pre.appendChild(code);
      bubble.appendChild(pre);
      return bubble;
    }
    if (t === 'card') {
      const card = document.createElement('div');
      card.className = 'card';
      if (block.title) {
        const title = document.createElement('div');
        title.className = 'card-title';
        title.textContent = block.title;
        card.appendChild(title);
      }
      if (block.body) {
        const body = document.createElement('div');
        body.className = 'card-body';
        body.innerHTML = marked.parse(block.body);
        card.appendChild(body);
      }
      if (block.actions && block.actions.length) {
        const acts = document.createElement('div');
        acts.className = 'card-actions';
        for (const a of block.actions) {
          const btn = document.createElement('button');
          btn.className = 'card-btn';
          btn.textContent = a.label;
          btn.onclick = () => bridge && bridge.cardAction(a.value || a.label);
          acts.appendChild(btn);
        }
        card.appendChild(acts);
      }
      return card;
    }
    // fallback
    const d = document.createElement('div');
    return d;
  }

  /* ─── 代码复制按钮 ─── */
  function _bindCodeCopy(el) {
    el.querySelectorAll('pre').forEach(pre => {
      if (pre.querySelector('.copy-btn')) return;
      const code = pre.querySelector('code');
      if (!code) return;
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = '复制';
      btn.onclick = () => _copy(code.textContent, btn);
      pre.insertBefore(btn, pre.firstChild);
    });
  }

  function _copy(text, btn) {
    const ok = _copyToClipboard(text);
    btn.textContent = ok ? '已复制' : '复制失败';
    setTimeout(() => { btn.textContent = '复制'; }, 1500);
  }

  /* ─── 右键引用菜单 ─── */
  function _hideCtxMenu() {
    if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
  }

  function _extractBubbleText(bubble) {
    const content = bubble.querySelector('.bubble-content');
    const el = content || bubble;
    return (el.textContent || '').trim().slice(0, 200);
  }

  function _showCtxMenu(e, bubble) {
    _hideSelectionCopy(true);
    _hideCtxMenu();
    const menu = document.createElement('div');
    menu.id = 'chat-ctx-menu';
    const item = document.createElement('div');
    item.className = 'ctx-item';
    item.textContent = '引用回复';
    item.onclick = () => {
      const text = _extractBubbleText(bubble);
      _hideCtxMenu();
      if (bridge && text) bridge.quoteActivated(text);
    };
    menu.appendChild(item);
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    document.body.appendChild(menu);
    _ctxMenu = menu;
    document.addEventListener('click', _hideCtxMenu, { once: true });
  }

  function clearQuote() {
    // Python 清除引用时调用，JS 侧预留
  }

  /* ─── 灯箱 ─── */
  function openLightbox(src) {
    _hideSelectionCopy(true);
    document.getElementById('lightbox-img').src = src;
    document.getElementById('lightbox').classList.add('open');
  }

  function closeLightbox() {
    document.getElementById('lightbox').classList.remove('open');
  }

  function scrollToBottom() {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  function clear() {
    _hideSelectionCopy(true);
    document.getElementById('messages').innerHTML = '';
  }

  // 自动初始化
  document.addEventListener('DOMContentLoaded', init);

  return { appendMessage, startStream, appendDelta, endStream, scrollToBottom, clear, openLightbox, closeLightbox, clearQuote };
})();
