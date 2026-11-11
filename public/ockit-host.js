(() => {
  window.mountOckitEditor = function (html, url, token, hostUrl) {
    const host = new URL(hostUrl);
    const editorOrigin = host.origin;
    if (editorOrigin === location.origin) throw new Error('編輯器需要使用獨立的閱覽網域');
    const frame = document.createElement('iframe');
    frame.title = '角色網站編輯器';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads allow-popups');
    frame.referrerPolicy = 'no-referrer';
    const request = async (message) => {
      const target = new URL(url, location.origin);
      const options = { headers: { Authorization: 'Bearer ' + token } };
      if (message.action === 'read') target.searchParams.set('file', message.path);
      if (message.action === 'save') {
        options.method = 'PUT';
        options.body = new FormData();
        options.body.set('revision', message.revision);
        options.body.set('paths', JSON.stringify(message.paths));
        if (typeof message.entry === 'string') options.body.set('entry', message.entry);
        if (typeof message.title === 'string') options.body.set('title', message.title);
        for (const entry of message.files) {
          options.body.append('relativePaths', entry.path);
          options.body.append('files', entry.blob, 'attachment');
        }
      }
      const response = await fetch(target, options);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || '無法存取項目附件');
      }
      return message.action === 'read' ? response.blob() : response.json();
    };
    window.addEventListener('message', async (event) => {
      const message = event.data;
      if (event.source !== frame.contentWindow || event.origin !== editorOrigin || !message) return;
      if (message.type === 'ockit-ready') {
        frame.contentWindow.postMessage({ type: 'ockit-init', html }, editorOrigin);
        return;
      }
      if (message.type !== 'ockit-request' ||
          !['list', 'read', 'save'].includes(message.action)) return;
      const reply = { type: 'ockit-response', id: message.id };
      try { reply.result = await request(message); }
      catch (error) { reply.error = error.message; }
      frame.contentWindow.postMessage(reply, editorOrigin);
    });
    frame.src = host.href;
    document.body.replaceChildren(frame);
  };
})();
