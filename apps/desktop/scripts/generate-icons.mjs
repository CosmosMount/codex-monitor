import { Buffer } from "node:buffer";
import console from "node:console";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

app.whenReady().then(async () => {
  const projectRoot = join(scriptDirectory, "..");
  const svg = readFileSync(join(projectRoot, "build", "icon.svg"), "utf8");
  const window = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    width: 512,
    height: 512,
    useContentSize: true
  });
  const html = `<!doctype html><style>html,body{width:100%;height:100%;margin:0;background:transparent;overflow:hidden}svg{display:block;width:100%;height:100%}</style>${svg}`;
  await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  if (image.isEmpty()) throw new Error("Electron could not render build/icon.svg");
  writeFileSync(join(projectRoot, "build", "icon.png"), image.toPNG());
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
