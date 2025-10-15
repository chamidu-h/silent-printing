// main.js - Complete Electron Print Agent
const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const express = require('express');
const bodyParser = require('body-parser');
const AutoLaunch = require('auto-launch');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const path = require('path');

let tray = null;
let mainWindow = null;

// Configure auto-launch on system boot
const autoLauncher = new AutoLaunch({
  name: 'Silent Print Agent',
  isHidden: true
});

// Initialize app when ready
app.whenReady().then(async () => {
  try {
    // Enable auto-start on boot
    const isEnabled = await autoLauncher.isEnabled();
    if (!isEnabled) {
      await autoLauncher.enable();
      console.log('✅ Auto-launch enabled');
    }
  } catch (error) {
    console.error('Auto-launch setup error:', error);
  }
  
  // Create system tray icon
  createTray();
  
  // Start local print server
  startPrintServer();
  
  console.log('🚀 Silent Print Agent started successfully');
});

// Prevent app from quitting when all windows are closed
app.on('window-all-closed', (e) => {
  // Keep app running in background
  if (process.platform !== 'darwin') {
    // On macOS, don't quit
  }
});

// macOS: Re-activate app when clicked in dock
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    // Don't create window, just show tray menu
  }
});

// Quit app completely
app.on('before-quit', () => {
  app.isQuitting = true;
});

function createTray() {
  // Create tray icon
  const iconPath = path.join(__dirname, 'icon.png');
  
  // Create native image with proper sizing
  const icon = nativeImage.createFromPath(iconPath);
  const resizedIcon = icon.resize({ width: 16, height: 16 });
  
  tray = new Tray(resizedIcon);
  tray.setToolTip('Silent Print Agent - Running');
  
  // Create context menu
  const contextMenu = Menu.buildFromTemplate([
    { 
      label: '🖨️ Silent Print Agent', 
      enabled: false,
      icon: resizedIcon
    },
    { type: 'separator' },
    { 
      label: '✓ Status: Running on port 4000', 
      enabled: false 
    },
    { 
      label: '🌐 Endpoint: http://localhost:4000', 
      enabled: false 
    },
    { type: 'separator' },
    { 
      label: 'Test Print', 
      click: () => {
        testPrint();
      }
    },
    { 
      label: 'View Logs', 
      click: () => {
        showLogs();
      }
    },
    { type: 'separator' },
    { 
      label: 'Quit', 
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
  
  tray.setContextMenu(contextMenu);
  
  // Show notification on tray click (optional)
  tray.on('click', () => {
    tray.popUpContextMenu();
  });
}

function startPrintServer() {
  const server = express();
  server.use(bodyParser.json({ limit: '50mb' }));
  server.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
  
  // Health check endpoint
  server.get('/', (req, res) => {
    res.json({ 
      status: 'running',
      version: '1.0.0',
      port: 4000,
      platform: os.platform(),
      message: 'Silent Print Agent is active'
    });
  });
  
  server.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  
  // Get available printers
  server.get('/printers', async (req, res) => {
    try {
      const printers = await getAvailablePrinters();
      res.json({ success: true, printers });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // Main print endpoint
  server.post('/print', async (req, res) => {
    const startTime = Date.now();
    console.log(`\n[${new Date().toISOString()}] 📥 Print request received`);
    
    try {
      const { pdfBase64, printerName } = req.body;
      
      // Validate input
      if (!pdfBase64) {
        throw new Error('Missing pdfBase64 in request body');
      }
      
      if (!printerName) {
        throw new Error('Missing printerName in request body');
      }
      
      console.log(`🖨️  Printer: ${printerName}`);
      console.log(`📄 PDF Size: ${(pdfBase64.length / 1024).toFixed(2)} KB`);
      
      // Save PDF to temp file
      const pdfPath = await savePDF(pdfBase64);
      console.log(`💾 PDF saved: ${pdfPath}`);
      
      // Print the PDF
      await silentPrint(pdfPath, printerName);
      
      // Clean up temp file
      try {
        fs.unlinkSync(pdfPath);
        console.log(`🗑️  Temp file deleted`);
      } catch (cleanupError) {
        console.warn('Cleanup warning:', cleanupError.message);
      }
      
      const duration = Date.now() - startTime;
      console.log(`✅ Print completed in ${duration}ms\n`);
      
      res.json({ 
        success: true, 
        message: 'Bill printed successfully',
        duration: `${duration}ms`
      });
      
    } catch (error) {
      console.error('❌ Print error:', error.message);
      res.status(500).json({ 
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });
  
  // Start server
  const PORT = 4000;
  server.listen(PORT, 'localhost', () => {
    console.log('============================================================');
    console.log(`✅ Print Agent v1.0.0 running on http://localhost:${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   Print endpoint: http://localhost:${PORT}/print`);
    console.log(`   Platform: ${os.platform()}`);
    console.log('============================================================');
  });
}

async function silentPrint(pdfPath, printerName) {
  const platform = os.platform();
  
  if (platform === 'win32') {
    // Windows: Use Electron's native print API
    return new Promise((resolve, reject) => {
      const printWindow = new BrowserWindow({ 
        show: false,
        webPreferences: {
          offscreen: true,
          nodeIntegration: false,
          contextIsolation: true
        }
      });
      
      printWindow.loadFile(pdfPath);
      
      printWindow.webContents.on('did-finish-load', () => {
        // Wait for rendering to complete
        setTimeout(() => {
          printWindow.webContents.print({
            silent: true,
            deviceName: printerName,
            printBackground: true,
            margins: {
              marginType: 'none'
            }
          }, (success, failureReason) => {
            printWindow.close();
            
            if (!success) {
              reject(new Error(failureReason || 'Print failed'));
            } else {
              console.log('✓ Windows print successful');
              resolve();
            }
          });
        }, 1000);
      });
      
      printWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        printWindow.close();
        reject(new Error(`Failed to load PDF: ${errorDescription}`));
      });
    });
    
  } else if (platform === 'darwin') {
    // macOS: Use lp command
    try {
      await execPromise(`lp -d "${printerName}" "${pdfPath}"`);
      console.log('✓ macOS print successful');
    } catch (error) {
      throw new Error(`macOS print failed: ${error.message}`);
    }
    
  } else {
    // Linux: Use lp command
    try {
      await execPromise(`lp -d "${printerName}" "${pdfPath}"`);
      console.log('✓ Linux print successful');
    } catch (error) {
      throw new Error(`Linux print failed: ${error.message}`);
    }
  }
}

async function savePDF(base64Data) {
  // Remove data URL prefix if present
  const base64Clean = base64Data.replace(/^data:application\/pdf;base64,/, '');
  
  const buffer = Buffer.from(base64Clean, 'base64');
  const tempPath = path.join(os.tmpdir(), `receipt_${Date.now()}.pdf`);
  
  fs.writeFileSync(tempPath, buffer);
  
  return tempPath;
}

async function getAvailablePrinters() {
  const platform = os.platform();
  
  if (platform === 'darwin' || platform === 'linux') {
    const { stdout } = await execPromise('lpstat -p -d');
    return stdout.trim().split('\n');
  } else if (platform === 'win32') {
    // Windows: Get printers using WMI
    const { stdout } = await execPromise('wmic printer get name');
    const printers = stdout.split('\n')
      .map(line => line.trim())
      .filter(line => line && line !== 'Name');
    return printers;
  }
  
  return [];
}

function testPrint() {
  console.log('Test print triggered from tray menu');
  // You can implement a test print functionality here
}

function showLogs() {
  // Open console or log file
  console.log('Show logs clicked');
}
