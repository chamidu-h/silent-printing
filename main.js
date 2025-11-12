// main.js - Complete Electron Print Agent with Settings UI
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
} = require("electron");
const { execSync } = require('child_process');

const express = require("express");
const bodyParser = require("body-parser");
const AutoLaunch = require("auto-launch");
const Store = require("electron-store");
const path = require("path");
const os = require("os");
const fs = require("fs");
const cheerio = require("cheerio");

// Initialize persistent store with defaults
const store = new Store({
  defaults: {
    port: 4000,
    printerName: "XP-80C Main",
    kotPrinterName: "XP-80C",
  },
});

let tray = null;
let settingsWindow = null;
let server = null;

// Configure auto-launch on system boot
const autoLauncher = new AutoLaunch({
  name: "Silent Print Agent",
  isHidden: true,
});

// Initialize app when ready
app.whenReady().then(async () => {
  try {
    // Enable auto-start on boot
    const isEnabled = await autoLauncher.isEnabled();
    if (!isEnabled) {
      await autoLauncher.enable();
      console.log("✅ Auto-launch enabled");
    }
  } catch (error) {
    console.error("Auto-launch setup error:", error);
  }

  // Create system tray icon
  createTray();

  // Start local print server
  startPrintServer();

  console.log("🚀 Silent Print Agent started successfully");
});

// Prevent app from quitting when all windows are closed
app.on("window-all-closed", (e) => {
  // Keep app running in background
});

// macOS: Re-activate app when clicked in dock
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    // Don't create window, just show tray menu
  }
});

// Quit app completely
app.on("before-quit", () => {
  app.isQuitting = true;
});

function createTray() {
  // Create tray icon
  const iconPath = path.join(__dirname, "icon.png");

  // Create native image with proper sizing
  const icon = nativeImage.createFromPath(iconPath);
  const resizedIcon = icon.resize({ width: 16, height: 16 });

  tray = new Tray(resizedIcon);
  tray.setToolTip("Silent Print Agent - Running");

  updateTrayMenu();

  // Show notification on tray click (optional)
  tray.on("click", () => {
    tray.popUpContextMenu();
  });
}

function updateTrayMenu() {
  const currentPort = store.get("port");
  const iconPath = path.join(__dirname, "icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  const resizedIcon = icon.resize({ width: 16, height: 16 });

  // Create context menu
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "🖨️ Silent Print Agent",
      enabled: false,
      icon: resizedIcon,
    },
    { type: "separator" },
    {
      label: `✓ Status: Running on port ${currentPort}`,
      enabled: false,
    },
    {
      label: `🌐 Endpoint: http://localhost:${currentPort}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Settings",
      click: () => {
        openSettings();
      },
    },
    {
      label: "Test Print",
      click: () => {
        testPrint();
      },
    },
    {
      label: "View Logs",
      click: () => {
        showLogs();
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function openSettings() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 580,
    height: 720,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Print Agent Settings",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, "preload.js"), // Best practice
    },
  });

  settingsWindow.loadFile("settings.html");

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

// IPC handlers for settings
ipcMain.on("get-settings", (event) => {
  event.returnValue = {
    port: store.get("port"),
    printerName: store.get("printerName"),
    kotPrinterName: store.get("kotPrinterName"),
  };
});

ipcMain.on("save-settings", (event, settings) => {
  const oldPort = store.get("port");

  store.set("port", settings.port);
  store.set("printerName", settings.printerName);
  store.set("kotPrinterName", settings.kotPrinterName); 
  

  event.returnValue = { success: true };
  updateTrayMenu(); // Update tray to reflect new settings if needed

  // If port changed, notify user to restart
  if (oldPort !== settings.port) {
    const { dialog } = require("electron");
    dialog
      .showMessageBox(settingsWindow, {
        type: "info",
        title: "Restart Required",
        message: "Port settings updated successfully!",
        detail: "Please restart the Print Agent for changes to take effect.",
        buttons: ["Restart Now", "Later"],
      })
      .then((result) => {
        if (result.response === 0) {
          app.relaunch();
          app.quit();
        }
      });
  } else {
    settingsWindow.close();
  }
});



function startPrintServer() {
  const PORT = store.get("port");
  const defaultPrinter = store.get("printerName");

  server = express();
  server.use(express.json({ limit: "50mb" }));
  server.use(express.urlencoded({ limit: "50mb", extended: true }));

  const cors = require("cors");
  server.use(cors({ origin: "*" }));

  // Health check endpoint
  server.get("/", (req, res) => {
    res.json({
      status: "running",
      version: "1.0.0",
      port: PORT,
      platform: os.platform(),
      defaultPrinter: defaultPrinter,
      kotPrinter: store.get("kotPrinterName"),
      message: "Silent Print Agent is active",
    });
  });

  server.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Get available printers
  server.get("/printers", async (req, res) => {
    try {
      const tempWindow = new BrowserWindow({ show: false });
      const printers = await tempWindow.webContents.getPrintersAsync();
      tempWindow.close();

      res.json({
        success: true,
        printers: printers.map((p) => ({
          name: p.name,
          displayName: p.displayName,
          status: p.status,
          isDefault: p.isDefault,
          options: p.options,
        })),
      });
    } catch (error) {
      console.error("❌ Error fetching printers:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

 // The updated endpoint
server.post("/print", async (req, res) => {
  const { html } = req.body;
  if (!html) return res.status(400).json({ success: false, error: "Missing html in request body" });

  const storedPrinterName = store.get("printerName");
  if (!storedPrinterName) return res.status(500).json({ success: false, error: "No printer configured." });

  let printWindow;
  
  try {
    // Resolve the target printer
    const tmpWindow = new BrowserWindow({ show: false });
    const printers = await tmpWindow.webContents.getPrintersAsync();
    tmpWindow.close();
    
    let targetPrinter = printers.find(p => p.name === storedPrinterName);
    
    // Fallback to default printer if configured printer not found
    if (!targetPrinter) {
      const defaultPrinters = printers.filter(p => p.isDefault);
      if (defaultPrinters.length > 0) {
        targetPrinter = defaultPrinters[0];
        console.log(`⚠️ Printer "${storedPrinterName}" not found, using default: ${targetPrinter.name}`);
      } else {
        return res.status(404).json({ 
          success: false, 
          error: `Printer "${storedPrinterName}" not found and no default printer available.` 
        });
      }
    }

    // Create print window - MUST BE VISIBLE for proper rendering
    printWindow = new BrowserWindow({
      show: false,  // Keep hidden but render on-screen
      width: 800,
      height: 600,
      webPreferences: {
        sandbox: false,
        contextIsolation: false,
        nodeIntegration: false,
        webSecurity: false,
        offscreen: false  // CRITICAL: Must be false for proper DPI rendering
      }
    });

    // CRITICAL: Set zoom BEFORE loading content
    printWindow.webContents.setZoomFactor(1.0);
    printWindow.webContents.setVisualZoomLevelLimits(1, 1);

    // EVENT-DRIVEN APPROACH
    printWindow.webContents.on('did-finish-load', async () => {
      try {
        console.log('📄 Page loaded, waiting for resources...');
        
        // Wait for all resources
        await printWindow.webContents.executeJavaScript(`
          (async () => {
            const imgs = Array.from(document.images);
            await Promise.all(imgs.map(img => img.complete ? Promise.resolve()
              : new Promise(r => { img.onload = img.onerror = r; })));
            
            if (document.fonts && document.fonts.ready) { 
              await document.fonts.ready; 
            }
            
            await new Promise(resolve => {
              let attempts = 0;
              const checkBarcode = () => {
                const barcodeElements = document.querySelectorAll('[id^="barcode-"]');
                const hasBarcode = Array.from(barcodeElements).some(el => el.querySelector('rect'));
                
                if (hasBarcode || attempts > 50) {
                  resolve();
                } else {
                  attempts++;
                  setTimeout(checkBarcode, 100);
                }
              };
              checkBarcode();
            });
            
            await new Promise(r => setTimeout(r, 300));
          })();
        `, true);

        console.log('✅ All resources loaded');

        console.log(`🖨️ Printing to ${targetPrinter.name}...`);

        // THE FIX: Minimal options that let printer driver handle everything
        // This makes silent:true behave like silent:false (dialog mode)
        printWindow.webContents.print({
          silent: true,
          deviceName: targetPrinter.name,
          printBackground: true,
          color: false,
          // DON'T specify margins - let printer use its defaults
          // DON'T specify pageSize - let printer use its defaults  
          // DON'T specify dpi - let printer use its native DPI
          // DON'T specify scaleFactor - let printer handle scaling
          
          // Only specify what's absolutely necessary
          landscape: false,
          pagesPerSheet: 1,
          collate: false,
          copies: 1
        }, (success, failureReason) => {
          console.log('🖨️ Print callback triggered');
          
          if (!printWindow.isDestroyed()) {
            printWindow.close();
          }
          
          if (success) {
            console.log('✅ Print successful');
            return res.json({ 
              success: true, 
              message: "Bill sent to printer successfully",
              printer: targetPrinter.name
            });
          } else {
            console.error('❌ Print failed:', failureReason);
            return res.status(500).json({ 
              success: false, 
              error: failureReason || "Print failed" 
            });
          }
        });
        
      } catch (resourceError) {
        console.error('❌ Resource loading error:', resourceError);
        if (!printWindow.isDestroyed()) printWindow.close();
        return res.status(500).json({ 
          success: false, 
          error: `Resource loading failed: ${resourceError.message}` 
        });
      }
    });

    printWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      console.error('❌ Page load failed:', errorCode, errorDescription);
      if (!printWindow.isDestroyed()) printWindow.close();
      return res.status(500).json({ 
        success: false, 
        error: `Failed to load content: ${errorDescription}` 
      });
    });

    // Load the HTML
    printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  } catch (err) {
    console.error('❌ Print error:', err);
    if (printWindow && !printWindow.isDestroyed()) printWindow.close();
    return res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// NEW KOT PRINT ENDPOINT
server.post("/print-kot", async (req, res) => {
  const { html } = req.body;
  if (!html) return res.status(400).json({ success: false, error: "Missing html in request body" });

  const storedKotPrinterName = store.get("kotPrinterName");
  if (!storedKotPrinterName) return res.status(500).json({ success: false, error: "No KOT printer configured." });

  let printWindow;
  
  try {
    // Resolve the target printer
    const tmpWindow = new BrowserWindow({ show: false });
    const printers = await tmpWindow.webContents.getPrintersAsync();
    tmpWindow.close();
    
    let targetPrinter = printers.find(p => p.name === storedKotPrinterName);
    
    // Fallback to default printer if configured printer not found
    if (!targetPrinter) {
      const defaultPrinters = printers.filter(p => p.isDefault);
      if (defaultPrinters.length > 0) {
        targetPrinter = defaultPrinters[0];
        console.log(`⚠️ KOT Printer "${storedKotPrinterName}" not found, using default: ${targetPrinter.name}`);
      } else {
        return res.status(404).json({ 
          success: false, 
          error: `KOT Printer "${storedKotPrinterName}" not found and no default printer available.` 
        });
      }
    }

    // Create print window
    printWindow = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        sandbox: false,
        contextIsolation: false,
        nodeIntegration: false,
        webSecurity: false,
        offscreen: false
      }
    });

    printWindow.webContents.setZoomFactor(1.0);
    printWindow.webContents.setVisualZoomLevelLimits(1, 1);

    printWindow.webContents.on('did-finish-load', async () => {
      try {
        console.log('📄 KOT Page loaded, waiting for resources...');
        
        // Wait for all resources
        await printWindow.webContents.executeJavaScript(`
          (async () => {
            const imgs = Array.from(document.images);
            await Promise.all(imgs.map(img => img.complete ? Promise.resolve()
              : new Promise(r => { img.onload = img.onerror = r; })));
            
            if (document.fonts && document.fonts.ready) { 
              await document.fonts.ready; 
            }
            
            await new Promise(r => setTimeout(r, 300));
          })();
        `, true);

        console.log('✅ All KOT resources loaded');
        console.log(`🖨️ Printing KOT to ${targetPrinter.name}...`);

        printWindow.webContents.print({
          silent: true,
          deviceName: targetPrinter.name,
          printBackground: true,
          color: false,
          landscape: false,
          pagesPerSheet: 1,
          collate: false,
          copies: 1
        }, (success, failureReason) => {
          console.log('🖨️ KOT Print callback triggered');
          
          if (!printWindow.isDestroyed()) {
            printWindow.close();
          }
          
          if (success) {
            console.log('✅ KOT Print successful');
            return res.json({ 
              success: true, 
              message: "KOT sent to printer successfully",
              printer: targetPrinter.name
            });
          } else {
            console.error('❌ KOT Print failed:', failureReason);
            return res.status(500).json({ 
              success: false, 
              error: failureReason || "KOT Print failed" 
            });
          }
        });
        
      } catch (resourceError) {
        console.error('❌ KOT Resource loading error:', resourceError);
        if (!printWindow.isDestroyed()) printWindow.close();
        return res.status(500).json({ 
          success: false, 
          error: `KOT Resource loading failed: ${resourceError.message}` 
        });
      }
    });

    printWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      console.error('❌ KOT Page load failed:', errorCode, errorDescription);
      if (!printWindow.isDestroyed()) printWindow.close();
      return res.status(500).json({ 
        success: false, 
        error: `Failed to load KOT content: ${errorDescription}` 
      });
    });

    // Load the HTML
    printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  } catch (err) {
    console.error('❌ KOT Print error:', err);
    if (printWindow && !printWindow.isDestroyed()) printWindow.close();
    return res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});




  // Start server
  server.listen(PORT, "localhost", () => {
    console.log("============================================================");
    console.log(`✅ Print Agent v1.0.0 running on http://localhost:${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   Print endpoint: http://localhost:${PORT}/print`);
    console.log(`   Default Printer: ${defaultPrinter}`);
    console.log(`   Platform: ${os.platform()}`);
    console.log("============================================================");
  });
}

function testPrint() {
    const { dialog } = require("electron");
    const storedPrinterName = store.get("printerName");
  
    const testHtml = `
      <div style="font-family: monospace; width: 80mm; padding: 5px; box-sizing: border-box;">
        <h2 style="text-align: center;">Test Print</h2>
        <p>--------------------------------</p>
        <p>Printer: ${storedPrinterName}</p>
        <p>Status: Success</p>
        <p>Time: ${new Date().toLocaleTimeString()}</p>
        <p>--------------------------------</p>
        <p style="text-align: center;">Print Agent is working!</p>
      </div>
    `;
  
    // Reuse the print logic
    const printPayload = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: testHtml }),
    };
  
    fetch(`http://localhost:${store.get("port")}/print`, printPayload)
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          dialog.showMessageBox({
            type: "info",
            title: "Test Print",
            message: "Test print sent successfully!",
          });
        } else {
          throw new Error(data.error);
        }
      })
      .catch(err => {
        console.error("Test print failed:", err);
        dialog.showErrorBox("Test Print Failed", err.message || "Could not connect to the print server.");
      });
  
    console.log("Test print triggered from tray menu");
  }

function showLogs() {
    const { shell } = require("electron");
    // This is a basic implementation. For production, you'd use a real logging library
    // and open the log file. For now, we can open the dev tools of a hidden window.
    const logWindow = new BrowserWindow({ show: false });
    logWindow.webContents.openDevTools();
    console.log("Developer tools opened for log inspection. Close the new window to dismiss.");
}
