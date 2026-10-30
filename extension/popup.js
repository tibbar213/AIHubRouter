document.getElementById('side').addEventListener('click',()=>{
  chrome.windows.getCurrent(win=>{
    if(chrome.runtime.lastError || !win?.id){document.getElementById('error').textContent='无法确定浏览器窗口，请从扩展管理页打开设置。';return;}
    if(!chrome.sidePanel?.open){document.getElementById('error').textContent='当前浏览器不支持打开侧栏，请使用 Chrome 或 Edge 的扩展侧栏。';return;}
    chrome.sidePanel.open({windowId:win.id}).then(()=>window.close()).catch(()=>{document.getElementById('error').textContent='侧栏未能打开，请检查浏览器是否支持扩展侧栏。';});
  });
});
