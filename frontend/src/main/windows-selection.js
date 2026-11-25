"use strict";

const { execFile } = require("node:child_process");
const path = require("node:path");
const script = path.join(__dirname, "windows-read-selection.ps1");

async function windowsSelection() {
    const command = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return new Promise(resolve => {
        execFile(command, ["-NoProfile", "-NonInteractive", "-STA", "-File", script,
            "-ExcludeProcessId", String(process.pid)], { windowsHide: true, timeout: 6500, maxBuffer: 128 * 1024 }, (error, stdout) => {
            if (error) {
                resolve({ error: "selection_unsupported" });
                return;
            }
            try {
                const result = JSON.parse(stdout);
                resolve(result.error === "selection_external_focus" ? { error: result.error } :
                    { text: result.text, source: "Windows の選択範囲（Ctrl+Alt+Q）", page: null });
            } catch {
                resolve({ error: "selection_unsupported" });
            }
        });
    });
}

module.exports = { windowsSelection };
