const { globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
module.exports = ({ ipcMain, getAdmin, openAdmin }) => {
  const config = path.join(__dirname, 'voice-controls.json');
  let key = 'F8', registered = false, held = false, error = '';
  try { const saved = JSON.parse(fs.readFileSync(config, 'utf8')).key; if (['F8','F9','F10'].includes(saved)) key = saved; } catch {}
  async function call(body) {
    const token = fs.readFileSync('D:/KeiRuntime/data/desktop-bridge.token', 'utf8').trim();
    const response = await fetch('http://127.0.0.1:17881/voice-input', {
      method: body ? 'POST' : 'GET', headers: {'X-Kei-Bridge': token, 'Content-Type': 'application/json'},
      ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(4000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || `HTTP ${response.status}`);
    return result;
  }
  function press() {
    if (held) return;
    held = true;
    // Wait for physical key release, so holding a key cannot submit repeated turns.
    let released = false, finished = false;
    const unlock = () => { if (released && finished) held = false; };
    execFile('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',
      path.join(__dirname,'voice-key-release.ps1'), '-VirtualKey', String(111 + Number(key.slice(1)))],
      {windowsHide:true}, (err) => {
        if (err) { error = 'キーを離したことを検出できませんでした。Desktop を再起動してください。管理画面のボタンは引き続き使えます。'; openAdmin(); return; }
        released = true; unlock();
      });
    call({action:'toggle'}).then(() => { error = ''; }).catch(e => { error = e.message; openAdmin(); })
      .finally(() => { finished = true; unlock(); });
  }
  function register(next) {
    if (!['F8','F9','F10'].includes(next)) throw new Error('F8・F9・F10 から選んでください');
    if (registered && next === key) return;
    if (!globalShortcut.register(next, press)) throw new Error(`${next} は他のアプリに使われています`);
    try { fs.writeFileSync(config, JSON.stringify({key:next})); }
    catch (e) { globalShortcut.unregister(next); throw e; }
    if (registered) globalShortcut.unregister(key);
    key = next; registered = true;
  }
  try { register(key); } catch(e) { error = e.message; }
  ipcMain.handle('kei:voice', async (event, action, value) => {
    if (event.sender !== getAdmin()?.webContents) throw new Error('Unauthorized');
    if (action === 'key') { if (held) throw new Error('先にショートカットキーを離してください'); register(value); error = ''; }
    else if (action === 'mode') { await call({action:'mode',mode:value}); error = ''; }
    else if (action === 'toggle') { await call({action:'toggle'}); error = ''; }
    else if (action !== 'status') throw new Error('Invalid action');
    return {...await call(), key, registered, error};
  });
  return () => { if (registered) globalShortcut.unregister(key); };
};
