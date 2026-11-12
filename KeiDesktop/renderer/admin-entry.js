const adminButton = document.createElement("button");
adminButton.textContent = "后台";
adminButton.title = "连接、语音识别与播放状态";
adminButton.style.cssText = "position:fixed;top:14px;right:70px;z-index:100000;pointer-events:auto;-webkit-app-region:no-drag;padding:8px 16px;border:1px solid #9bd6ff;border-radius:8px;background:#18304ddd;color:white;cursor:pointer";
adminButton.onclick = () => window.keiDesktop.openAdmin();
document.body.append(adminButton);
