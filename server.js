// server.js - Complete version with dynamic pin configuration and toggle-all state persistence
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcrypt';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mqtt from 'mqtt';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import database from './database.js';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: function (origin, callback) {
      const allowedOrigins = [
        'http://localhost:3001',
        'http://localhost:8080',
        'http://192.168.32.65:3001',
        'https://yourdomain.com',
        process.env.FRONTEND_URL
      ].filter(Boolean);
      
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true
  }
});

// ==================== CORS CONFIGURATION ====================
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:3001',
      'http://localhost:8080',
      'http://192.168.32.65:3001',
      'https://yourdomain.com',
      process.env.FRONTEND_URL
    ].filter(Boolean);
    
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log(`❌ CORS blocked for origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ==================== MQTT CLIENT SETUP ====================
const mqttOptions = {
  clientId: `web_server_${crypto.randomBytes(8).toString('hex')}`,
  keepalive: 60,
  reconnectPeriod: 5000,
  connectTimeout: 30 * 1000,
  username: process.env.MQTT_USERNAME || null,
  password: process.env.MQTT_PASSWORD || null,
  will: {
    topic: 'server/status',
    payload: JSON.stringify({ 
      status: 'offline', 
      timestamp: Date.now(),
      clientId: `web_server_${crypto.randomBytes(8).toString('hex')}`
    }),
    qos: 1,
    retain: true
  }
};

let mqttClient = null;
let mqttConnectionStatus = {
  connected: false,
  lastConnection: null,
  error: null,
  reconnectCount: 0
};

function initializeMqtt() {
  try {
    console.log('🔗 Initializing MQTT connection...');
    mqttClient = mqtt.connect('mqtt://160.250.180.121:1883', mqttOptions);

    mqttClient.on('connect', () => {
      console.log('✅ MQTT Connected to broker.emqx.io');
      console.log(`📡 Client ID: ${mqttClient.options.clientId}`);
      
      mqttConnectionStatus.connected = true;
      mqttConnectionStatus.lastConnection = new Date();
      mqttConnectionStatus.error = null;
      mqttConnectionStatus.reconnectCount = 0;
      
      const topics = [
        'esp/+/status',
        'esp/+/auth', 
        'esp/+/auth_response',
        'esp/+/heartbeat',
        'esp/+/get_config',
        'esp/+/state_update',
        'esp/+/relay_state',
        'esp/+/config_request',
        'esp/+/pin_config_update',
        'server/status'
      ];
      
      topics.forEach(topic => {
        mqttClient.subscribe(topic, { qos: 1 }, (err) => {
          if (err) {
            console.error(`❌ Failed to subscribe to ${topic}:`, err);
          } else {
            console.log(`✅ Subscribed to topic: ${topic}`);
          }
        });
      });
      
      mqttClient.publish('server/status', JSON.stringify({
        status: 'online',
        timestamp: Date.now(),
        version: '3.0',
        clients: 0,
        clientId: mqttClient.options.clientId
      }), { qos: 1, retain: true });
    });

    mqttClient.on('error', (error) => {
      console.error('❌ MQTT Error:', error);
      mqttConnectionStatus.connected = false;
      mqttConnectionStatus.error = error.message;
    });

    mqttClient.on('close', () => {
      console.log('🔒 MQTT Connection closed');
      mqttConnectionStatus.connected = false;
    });

    mqttClient.on('offline', () => {
      console.error('❌ MQTT Offline');
      mqttConnectionStatus.connected = false;
    });

    mqttClient.on('reconnect', () => {
      console.log('🔄 MQTT Reconnecting...');
      mqttConnectionStatus.reconnectCount++;
    });

    mqttClient.on('end', () => {
      console.log('🔚 MQTT Connection ended');
      mqttConnectionStatus.connected = false;
    });

  } catch (error) {
    console.error('❌ Failed to initialize MQTT:', error);
    mqttConnectionStatus.error = error.message;
  }
}

initializeMqtt();

setInterval(() => {
  if (mqttClient && !mqttClient.connected) {
    console.log('⚠️ MQTT Health Check: DISCONNECTED - Attempting to reconnect...');
    mqttConnectionStatus.connected = false;
    
    if (mqttClient.reconnecting) {
      console.log('🔄 MQTT is already reconnecting...');
    } else {
      try {
        mqttClient.end(true);
        setTimeout(() => {
          initializeMqtt();
        }, 5000);
      } catch (error) {
        console.error('❌ Error during MQTT reconnection:', error);
      }
    }
  }
}, 30000);

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use(session({
  secret: process.env.SESSION_SECRET || 'esp32_secret_key_2025_secure_random',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: false,
    httpOnly: true
  }
}));

// ==================== HELPER FUNCTIONS ====================
function generateApiKey() {
  return 'ak_' + crypto.randomBytes(24).toString('hex') + '_' + Date.now().toString(36);
}

function isValidEspId(espId) {
  return /^[a-zA-Z0-9_-]{3,20}$/.test(espId);
}

function isValidUsername(username) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized - Please login first' });
  }
  next();
}

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - ${req.session.username || 'Guest'}`);
  next();
});

// ==================== AUTH APIs ====================
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 6 ký tự' });
    }
    
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Tên đăng nhập chỉ được chứa chữ cái, số và gạch dưới (3-20 ký tự)' });
    }
    
    const existingUser = await database.get('SELECT id FROM users WHERE username = ?', [username]);
    if (existingUser) {
      return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại' });
    }
    
    const hash = await bcrypt.hash(password, 12);
    const userId = 'user_' + Date.now().toString(36);
    const apiKey = generateApiKey();
    
    await database.run(
      'INSERT INTO users (id, username, password, last_login, session_count) VALUES (?, ?, ?, ?, ?)',
      [userId, username, hash, new Date().toISOString(), 1]
    );
    
    await database.run(
      'INSERT INTO api_keys (user_id, api_key) VALUES (?, ?)',
      [userId, apiKey]
    );
    
    req.session.userId = userId;
    req.session.username = username;
    
    console.log(`✅ User registered: ${username} (${userId})`);
    
    res.json({ 
      ok: true, 
      message: 'Đăng ký thành công!',
      apiKey,
      username
    });
    
  } catch (error) {
    console.error('❌ Registration error:', error);
    res.status(500).json({ error: 'Lỗi server khi đăng ký' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });
    }
    
    const user = await database.get('SELECT * FROM users WHERE username = ?', [username]);
    
    if (!user) {
      return res.status(401).json({ error: 'Tài khoản không tồn tại' });
    }
    
    if (!(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Sai mật khẩu' });
    }
    
    await database.run(
      'UPDATE users SET last_login = ?, session_count = COALESCE(session_count, 0) + 1 WHERE id = ?',
      [new Date().toISOString(), user.id]
    );
    
    req.session.userId = user.id;
    req.session.username = username;
    
    console.log(`✅ User logged in: ${username} (${user.id})`);
    
    res.json({ 
      ok: true, 
      message: 'Đăng nhập thành công!',
      username
    });
    
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ error: 'Lỗi server khi đăng nhập' });
  }
});

app.get('/api/logout', (req, res) => {
  const username = req.session.username;
  req.session.destroy((err) => {
    if (err) {
      console.error('❌ Logout error:', err);
      return res.status(500).json({ error: 'Lỗi khi đăng xuất' });
    }
    console.log(`✅ User logged out: ${username}`);
    res.json({ ok: true, message: 'Đã đăng xuất' });
  });
});

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  try {
    const userDevices = await database.all(
      'SELECT * FROM devices WHERE user_id = ? ORDER BY created_at DESC',
      [req.session.userId]
    );
    
    const apiKeyRow = await database.get(
      'SELECT api_key FROM api_keys WHERE user_id = ?',
      [req.session.userId]
    );
    
    res.json({ 
      username: req.session.username,
      userId: req.session.userId,
      apiKey: apiKeyRow ? apiKeyRow.api_key : null,
      esps: userDevices || [],
      deviceCount: userDevices ? userDevices.length : 0
    });
  } catch (error) {
    console.error('❌ Get user info error:', error);
    res.status(500).json({ error: 'Lỗi server khi lấy thông tin user' });
  }
});

// ==================== MQTT HEALTH CHECK APIs ====================
app.get('/api/mqtt/health', requireAuth, (req, res) => {
  try {
    const mqttHealth = {
      connected: mqttClient ? mqttClient.connected : false,
      broker: mqttClient ? (mqttClient.options?.host || 'Unknown') : 'Not initialized',
      port: mqttClient ? (mqttClient.options?.port || 'Unknown') : 'Not initialized',
      protocol: mqttClient ? (mqttClient.options?.protocol || 'Unknown') : 'Not initialized',
      clientId: mqttClient ? (mqttClient.options?.clientId || 'Unknown') : 'Not initialized',
      lastActivity: mqttClient ? (mqttClient.lastActivity || 'Never') : 'Never',
      reconnecting: mqttClient ? (mqttClient.reconnecting || false) : false,
      pending: mqttClient ? (mqttClient.getPending ? mqttClient.getPending() : 0) : 0,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      connectionStatus: mqttConnectionStatus
    };

    res.json({
      ok: true,
      mqtt: mqttHealth,
      system: {
        memory: process.memoryUsage(),
        platform: process.platform,
        nodeVersion: process.version
      }
    });
  } catch (error) {
    console.error('❌ MQTT Health Check error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to get MQTT health status',
      message: error.message
    });
  }
});

app.get('/api/mqtt/test-connection', requireAuth, async (req, res) => {
  try {
    if (!mqttClient || !mqttClient.connected) {
      return res.json({
        ok: false,
        message: 'MQTT Client không kết nối',
        connected: false,
        error: 'MQTT client not connected'
      });
    }

    const testTopic = `esp/health/test/${Date.now()}`;
    const testMessage = {
      test: 'MQTT Connection Test',
      timestamp: Date.now(),
      from: req.session.username
    };

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        res.json({
          ok: false,
          message: 'MQTT Test Timeout - Broker không phản hồi',
          connected: mqttClient.connected,
          error: 'Timeout'
        });
        resolve();
      }, 5000);

      mqttClient.publish(testTopic, JSON.stringify(testMessage), { qos: 1 }, (error) => {
        clearTimeout(timeout);
        if (error) {
          res.json({
            ok: false,
            message: `Lỗi gửi test message: ${error.message}`,
            connected: mqttClient.connected,
            error: error.message
          });
        } else {
          res.json({
            ok: true,
            message: '✅ Kết nối MQTT Broker hoạt động tốt',
            connected: true,
            topic: testTopic,
            details: {
              broker: mqttClient.options?.host,
              port: mqttClient.options?.port,
              clientId: mqttClient.options?.clientId
            }
          });
        }
        resolve();
      });
    });
  } catch (error) {
    console.error('❌ MQTT Test Connection Error:', error);
    res.status(500).json({
      ok: false,
      message: 'Lỗi khi kiểm tra kết nối MQTT',
      error: error.message
    });
  }
});

// ==================== TOGGLE ALL STATE MANAGEMENT APIs ====================
app.post('/api/esp/:id/toggle-all-state', requireAuth, async (req, res) => {
  try {
    const espId = req.params.id;
    const { state } = req.body;
    
    if (typeof state !== 'boolean') {
      return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
    }
    
    const device = await database.get(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
      [espId, req.session.userId]
    );
    
    if (!device) {
      return res.status(404).json({ error: 'Thiết bị không tồn tại' });
    }
    
    // Lưu trạng thái toggle-all vào database
    await database.run(
      `INSERT OR REPLACE INTO toggle_all_states (device_id, state, last_updated) 
       VALUES (?, ?, ?)`,
      [espId, state ? 1 : 0, new Date().toISOString()]
    );
    
    console.log(`💾 Saved toggle-all state: ${espId} = ${state}`);
    
    res.json({ 
      ok: true, 
      message: 'Đã lưu trạng thái toggle-all'
    });
    
  } catch (error) {
    console.error('❌ Save toggle-all state error:', error);
    res.status(500).json({ error: 'Lỗi server khi lưu trạng thái toggle-all' });
  }
});

app.get('/api/esp/:id/toggle-all-state', requireAuth, async (req, res) => {
  try {
    const espId = req.params.id;
    
    const device = await database.get(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
      [espId, req.session.userId]
    );
    
    if (!device) {
      return res.status(404).json({ error: 'Thiết bị không tồn tại' });
    }
    
    const toggleState = await database.get(
      'SELECT state FROM toggle_all_states WHERE device_id = ?',
      [espId]
    );
    
    res.json({ 
      ok: true,
      state: toggleState ? (toggleState.state === 1) : false
    });
    
  } catch (error) {
    console.error('❌ Get toggle-all state error:', error);
    res.status(500).json({ error: 'Lỗi server khi lấy trạng thái toggle-all' });
  }
});

// ==================== API KEY MANAGEMENT ====================
app.get('/api/user/apikey', requireAuth, async (req, res) => {
  try {
    let apiKeyRow = await database.get(
      'SELECT api_key FROM api_keys WHERE user_id = ?',
      [req.session.userId]
    );
    
    if (!apiKeyRow) {
      const newApiKey = generateApiKey();
      await database.run(
        'INSERT INTO api_keys (user_id, api_key) VALUES (?, ?)',
        [req.session.userId, newApiKey]
      );
      apiKeyRow = { api_key: newApiKey };
      console.log(`✅ Generated new API Key for user: ${req.session.username}`);
    }
    
    res.json({ 
      apiKey: apiKeyRow.api_key,
      message: 'Lấy API Key thành công'
    });
    
  } catch (error) {
    console.error('❌ Get API Key error:', error);
    res.status(500).json({ error: 'Lỗi server khi lấy API Key' });
  }
});

app.post('/api/user/apikey/new', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const username = req.session.username;
    
    const newApiKey = generateApiKey();
    
    await database.run(
      'INSERT OR REPLACE INTO api_keys (user_id, api_key) VALUES (?, ?)',
      [userId, newApiKey]
    );
    
    console.log(`✅ Generated new API Key for user: ${username}`);
    
    res.json({ 
      apiKey: newApiKey,
      message: 'Đã tạo API Key mới thành công'
    });
    
  } catch (error) {
    console.error('❌ Generate new API Key error:', error);
    res.status(500).json({ error: 'Lỗi server khi tạo API Key mới' });
  }
});

// ==================== DEVICE APIs - UPDATED FOR DYNAMIC RELAYS ====================
app.post('/api/esp/add', requireAuth, async (req, res) => {
  try {
    const { esp_id, label, max_relays = 10 } = req.body;
    
    if (!esp_id) {
      return res.status(400).json({ error: 'Thiếu ESP ID' });
    }
    
    if (!isValidEspId(esp_id)) {
      return res.status(400).json({ error: 'ESP ID chỉ được chứa chữ cái, số, gạch dưới và gạch ngang (3-20 ký tự)' });
    }
    
    if (max_relays < 1 || max_relays > 100) {
      return res.status(400).json({ error: 'Số relay tối đa phải từ 1 đến 100' });
    }
    
    const existingDevice = await database.get(
      'SELECT id FROM devices WHERE id = ? AND user_id = ?',
      [esp_id, req.session.userId]
    );
    
    if (existingDevice) {
      return res.status(409).json({ error: 'Thiết bị đã tồn tại' });
    }
    
    const otherUserDevice = await database.get(
      'SELECT id FROM devices WHERE id = ? AND user_id != ?',
      [esp_id, req.session.userId]
    );
    
    if (otherUserDevice) {
      return res.status(409).json({ error: 'ESP ID này đã được sử dụng bởi người dùng khác' });
    }
    
    await database.run(
      'INSERT INTO devices (id, user_id, label, max_relays, created_at) VALUES (?, ?, ?, ?, ?)',
      [esp_id, req.session.userId, label || esp_id, max_relays, new Date().toISOString()]
    );
    
    console.log(`✅ Device added: ${esp_id} for user: ${req.session.username} with ${max_relays} max relays`);
    
    res.json({ 
      ok: true, 
      message: 'Thêm thiết bị thành công',
      device: {
        id: esp_id,
        label: label || esp_id,
        max_relays: max_relays,
        createdAt: new Date().toISOString(),
        lastSeen: null,
        status: 'offline'
      }
    });
    
  } catch (error) {
    console.error('❌ Add device error:', error);
    res.status(500).json({ error: 'Lỗi server khi thêm thiết bị' });
  }
});

app.get('/api/esp/list', requireAuth, async (req, res) => {
  try {
    const userDevices = await database.all(
      'SELECT * FROM devices WHERE user_id = ? ORDER BY created_at DESC',
      [req.session.userId]
    );
    
    res.json({ 
      ok: true,
      devices: userDevices || []
    });
  } catch (error) {
    console.error('❌ List devices error:', error);
    res.status(500).json({ error: 'Lỗi server khi lấy danh sách thiết bị' });
  }
});

app.delete('/api/esp/:id', requireAuth, async (req, res) => {
  try {
    const espId = req.params.id;
    
    if (!espId) {
      return res.status(400).json({ error: 'Thiếu ESP ID' });
    }
    
    const device = await database.get(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
      [espId, req.session.userId]
    );
    
    if (!device) {
      return res.status(404).json({ error: 'Thiết bị không tồn tại hoặc không thuộc quyền sở hữu' });
    }
    
    await database.run('DELETE FROM devices WHERE id = ?', [espId]);
    await database.run('DELETE FROM relays WHERE device_id = ?', [espId]);
    await database.run('DELETE FROM relay_states WHERE device_id = ?', [espId]);
    await database.run('DELETE FROM toggle_all_states WHERE device_id = ?', [espId]);
    
    console.log(`🗑️ Device deleted: ${espId} for user: ${req.session.username}`);
    
    res.json({ 
      ok: true, 
      message: 'Đã xoá thiết bị thành công',
      deletedDevice: device
    });
    
  } catch (error) {
    console.error('❌ Delete device error:', error);
    res.status(500).json({ error: 'Lỗi server khi xoá thiết bị' });
  }
});

app.post('/api/esp/:id/cmd', requireAuth, async (req, res) => {
  try {
    const espId = req.params.id;
    const { payload } = req.body;
    
    if (!espId) {
      return res.status(400).json({ error: 'Thiếu ESP ID' });
    }
    
    if (!mqttClient || !mqttClient.connected) {
      return res.status(503).json({ error: 'MQTT client không kết nối' });
    }
    
    const device = await database.get(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
      [espId, req.session.userId]
    );
    
    if (!device) {
      return res.status(404).json({ error: 'Thiết bị không tồn tại hoặc không thuộc quyền sở hữu' });
    }
    
    const apiKeyRow = await database.get(
      'SELECT api_key FROM api_keys WHERE user_id = ?',
      [req.session.userId]
    );
    
    const commandWithAuth = {
      ...(typeof payload === 'object' ? payload : { command: payload }),
      apiKey: apiKeyRow.api_key,
      timestamp: Date.now(),
      from: req.session.username
    };
    
    const topic = `esp/${espId}/cmd`;
    const message = JSON.stringify(commandWithAuth);
    
    mqttClient.publish(topic, message, { qos: 1 }, (err) => {
      if (err) {
        console.error(`❌ Failed to publish to ${topic}:`, err);
        return res.status(500).json({ error: 'Lỗi khi gửi lệnh qua MQTT' });
      }
      
      console.log(`📤 Sent command to ${topic} from user: ${req.session.username}`, commandWithAuth);
      
      res.json({ 
        ok: true, 
        message: 'Đã gửi lệnh đến thiết bị',
        topic: topic
      });
    });
    
  } catch (error) {
    console.error('❌ Send command error:', error);
    res.status(500).json({ error: 'Lỗi server khi gửi lệnh' });
  }
});

// ==================== RELAY STATE MANAGEMENT APIs ====================
app.get('/api/esp/:id/relays/states', requireAuth, async (req, res) => {
  try {
    const espId = req.params.id;
    
    const device = await database.get(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
      [espId, req.session.userId]
    );
    
    if (!device) {
      return res.status(404).json({ error: 'Thiết bị không tồn tại' });
    }
    
    const relayStates = await database.all(
      `SELECT rs.relay_number, rs.state, rs.last_updated
       FROM relay_states rs
       WHERE rs.device_id = ?`,
      [espId]
    );
    
    const states = {};
    relayStates.forEach(state => {
      states[state.relay_number] = {
        state: state.state === 1,
        last_updated: state.last_updated
      };
    });
    
    res.json({ 
      ok: true,
      deviceId: espId,
      states: states
    });
    
  } catch (error) {
    console.error('❌ Get relay states error:', error);
    res.status(500).json({ error: 'Lỗi server khi lấy trạng thái relay' });
  }
});

app.post('/api/esp/:id/relays/:relayNumber/state', requireAuth, async (req, res) => {
  try {
    const espId = req.params.id;
    const relayNumber = parseInt(req.params.relayNumber);
    const { state } = req.body;
    
    if (typeof state !== 'boolean') {
      return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
    }
    
    const device = await database.get(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
      [espId, req.session.userId]
    );
    
    if (!device) {
      return res.status(404).json({ error: 'Thiết bị không tồn tại' });
    }
    
    await database.run(
      `INSERT OR REPLACE INTO relay_states (device_id, relay_number, state, last_updated) 
       VALUES (?, ?, ?, ?)`,
      [espId, relayNumber, state ? 1 : 0, new Date().toISOString()]
    );
    
    console.log(`💾 Saved relay state: ${espId} relay ${relayNumber} = ${state}`);
    
    io.emit('relay_state_updated', {
      deviceId: espId,
      relayNumber: relayNumber,
      state: state,
      timestamp: Date.now()
    });
    
    res.json({ 
      ok: true, 
      message: 'Đã lưu trạng thái relay'
    });
    
  } catch (error) {
    console.error('❌ Save relay state error:', error);
    res.status(500).json({ error: 'Lỗi server khi lưu trạng thái relay' });
  }
});

app.post('/api/esp/:id/relays/:relayNumber/state/update', async (req, res) => {
  try {
    const espId = req.params.id;
    const relayNumber = parseInt(req.params.relayNumber);
    const { state } = req.body;
    
    await database.run(
      `INSERT OR REPLACE INTO relay_states (device_id, relay_number, state, last_updated) 
       VALUES (?, ?, ?, ?)`,
      [espId, relayNumber, state ? 1 : 0, new Date().toISOString()]
    );
    
    io.emit('relay_state_updated', {
      deviceId: espId,
      relayNumber: relayNumber,
      state: state,
      timestamp: Date.now()
    });
    
    console.log(`📡 ESP32 updated relay state: ${espId} relay ${relayNumber} = ${state}`);
    
    res.json({ 
      ok: true, 
      message: 'Đã cập nhật trạng thái relay'
    });
    
  } catch (error) {
    console.error('❌ Update relay state error:', error);
    res.status(500).json({ error: 'Lỗi server khi cập nhật trạng thái' });
  }
});

// ==================== DYNAMIC RELAY MANAGEMENT APIs ====================
app.get('/api/esp/:id/relays/config', requireAuth, async (req, res) => {
  try {
    const espId = req.params.id;
    
    const device = await database.get(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
      [espId, req.session.userId]
    );
    
    if (!device) {
      return res.status(404).json({ error: 'Thiết bị không tồn tại' });
    }
    
    const relays = await database.all(
      `SELECT r.*, rs.state as last_state 
       FROM relays r 
       LEFT JOIN relay_states rs ON r.device_id = rs.device_id AND r.relay_number = rs.relay_number
       WHERE r.device_id = ? AND r.is_active = 1 
       ORDER BY r.relay_number`,
      [espId]
    );
    
    res.json({ 
      ok: true,
      relays: relays || [],
      max_relays: device.max_relays || 10
    });
    
  } catch (error) {
    console.error('❌ Get relay config error:', error);
    res.status(500).json({ error: 'Lỗi server khi lấy cấu hình relay' });
  }
});

app.post('/api/esp/:id/relays', requireAuth, async (req, res) => {
  try {
    const espId = req.params.id;
    const { relay_number, name, gpio_pin, relay_type, icon } = req.body;
    
    if (!relay_number || !name || !gpio_pin) {
      return res.status(400).json({ error: 'Thiếu thông tin relay' });
    }
    
    const device = await database.get(
      'SELECT max_relays FROM devices WHERE id = ? AND user_id = ?',
      [espId, req.session.userId]
    );
    
    if (!device) {
      return res.status(404).json({ error: 'Thiết bị không tồn tại' });
    }
    
    const maxRelays = device.max_relays || 50;
    if (relay_number < 1 || relay_number > maxRelays) {
      return res.status(400).json({ error: `Số relay phải từ 1 đến ${maxRelays}` });
    }
    
    const existingRelay = await database.get(
      'SELECT * FROM relays WHERE device_id = ? AND relay_number = ? AND is_active = 1',
      [espId, relay_number]
    );
    
    if (existingRelay) {
      return res.status(409).json({ error: 'Relay số ' + relay_number + ' đã tồn tại' });
    }
    
    const existingPin = await database.get(
      'SELECT * FROM relays WHERE device_id = ? AND gpio_pin = ? AND is_active = 1',
      [espId, gpio_pin]
    );
    
    if (existingPin) {
      return res.status(409).json({ error: 'GPIO ' + gpio_pin + ' đã được sử dụng' });
    }
    
    await database.run(
      `INSERT INTO relays (device_id, relay_number, name, gpio_pin, relay_type, icon, is_active) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [espId, relay_number, name, gpio_pin, relay_type || 'LOW', icon || 'fa-sliders-h', 1]
    );
    
    console.log(`✅ Relay added to ${espId}: ${name} (GPIO ${gpio_pin})`);
    
    // Gửi cấu hình mới đến ESP32 nếu đang online
    sendConfigToESP(espId);
    
    res.json({ 
      ok: true, 
      message: 'Đã thêm relay thành công',
      relay: {
        relay_number,
        name,
        gpio_pin,
        relay_type: relay_type || 'LOW',
        icon: icon || 'fa-sliders-h'
      }
    });
    
  } catch (error) {
    console.error('❌ Add relay error:', error);
    res.status(500).json({ error: 'Lỗi server khi thêm relay' });
  }
});

app.put('/api/esp/:id/relays/:relayNumber', requireAuth, async (req, res) => {
  try {
    const espId = req.params.id;
    const relayNumber = parseInt(req.params.relayNumber);
    const { name, gpio_pin, relay_type, icon } = req.body;
    
    const device = await database.get(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
      [espId, req.session.userId]
    );
    
    if (!device) {
      return res.status(404).json({ error: 'Thiết bị không tồn tại' });
    }
    
    const existingPin = await database.get(
      'SELECT * FROM relays WHERE device_id = ? AND gpio_pin = ? AND relay_number != ? AND is_active = 1',
      [espId, gpio_pin, relayNumber]
    );
    
    if (existingPin) {
      return res.status(409).json({ error: 'GPIO ' + gpio_pin + ' đã được sử dụng bởi relay khác' });
    }
    
    await database.run(
      `UPDATE relays SET name = ?, gpio_pin = ?, relay_type = ?, icon = ? 
       WHERE device_id = ? AND relay_number = ?`,
      [name, gpio_pin, relay_type, icon, espId, relayNumber]
    );
    
    console.log(`✅ Relay ${relayNumber} updated for ${espId}`);
    
    // Gửi cấu hình mới đến ESP32
    sendConfigToESP(espId);
    
    res.json({ 
      ok: true, 
      message: 'Đã cập nhật relay thành công'
    });
    
  } catch (error) {
    console.error('❌ Update relay error:', error);
    res.status(500).json({ error: 'Lỗi server khi cập nhật relay' });
  }
});

app.delete('/api/esp/:id/relays/:relayNumber', requireAuth, async (req, res) => {
  try {
    const espId = req.params.id;
    const relayNumber = parseInt(req.params.relayNumber);
    
    const device = await database.get(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
      [espId, req.session.userId]
    );
    
    if (!device) {
      return res.status(404).json({ error: 'Thiết bị không tồn tại' });
    }
    
    await database.run(
      'UPDATE relays SET is_active = 0 WHERE device_id = ? AND relay_number = ?',
      [espId, relayNumber]
    );
    
    await database.run(
      'DELETE FROM relay_states WHERE device_id = ? AND relay_number = ?',
      [espId, relayNumber]
    );
    
    console.log(`🗑️ Relay ${relayNumber} deleted from ${espId}`);
    
    // Gửi cấu hình mới đến ESP32
    sendConfigToESP(espId);
    
    res.json({ 
      ok: true, 
      message: 'Đã xóa relay thành công'
    });
    
  } catch (error) {
    console.error('❌ Delete relay error:', error);
    res.status(500).json({ error: 'Lỗi server khi xóa relay' });
  }
});

// API để cập nhật số lượng relay tối đa
app.put('/api/esp/:id/max-relays', requireAuth, async (req, res) => {
  try {
    const espId = req.params.id;
    const { max_relays } = req.body;
    
    if (!max_relays || max_relays < 1 || max_relays > 100) {
      return res.status(400).json({ error: 'Số relay tối đa phải từ 1 đến 100' });
    }
    
    const device = await database.get(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
      [espId, req.session.userId]
    );
    
    if (!device) {
      return res.status(404).json({ error: 'Thiết bị không tồn tại' });
    }
    
    const currentRelays = await database.all(
      'SELECT COUNT(*) as count FROM relays WHERE device_id = ? AND is_active = 1',
      [espId]
    );
    
    const currentCount = currentRelays[0]?.count || 0;
    if (currentCount > max_relays) {
      return res.status(400).json({ 
        error: `Không thể giảm max_relays vì hiện có ${currentCount} relay đang hoạt động` 
      });
    }
    
    await database.run(
      'UPDATE devices SET max_relays = ? WHERE id = ?',
      [max_relays, espId]
    );
    
    console.log(`✅ Updated max relays for ${espId}: ${max_relays}`);
    
    res.json({ 
      ok: true, 
      message: `Đã cập nhật số relay tối đa thành ${max_relays}`,
      max_relays: max_relays
    });
    
  } catch (error) {
    console.error('❌ Update max relays error:', error);
    res.status(500).json({ error: 'Lỗi server khi cập nhật số relay tối đa' });
  }
});

// API để ESP32 lấy cấu hình relay (không cần auth)
app.get('/api/esp/:id/config', async (req, res) => {
  try {
    const espId = req.params.id;
    
    const device = await database.get(
      'SELECT max_relays FROM devices WHERE id = ?',
      [espId]
    );
    
    const relays = await database.all(
      `SELECT r.relay_number, r.name, r.gpio_pin, r.relay_type, r.icon, 
              COALESCE(rs.state, 0) as last_state
       FROM relays r 
       LEFT JOIN relay_states rs ON r.device_id = rs.device_id AND r.relay_number = rs.relay_number
       WHERE r.device_id = ? AND r.is_active = 1 
       ORDER BY r.relay_number`,
      [espId]
    );
    
    res.json({ 
      ok: true,
      relays: relays || [],
      max_relays: device?.max_relays || 10,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Get relay config for ESP error:', error);
    res.status(500).json({ error: 'Lỗi server khi lấy cấu hình relay' });
  }
});

// ==================== DYNAMIC PIN CONFIGURATION APIs ====================
app.post('/api/esp/:id/pin-config', requireAuth, async (req, res) => {
  try {
    const espId = req.params.id;
    const { relay_number, gpio_pin } = req.body;
    
    if (!relay_number || gpio_pin === undefined) {
      return res.status(400).json({ error: 'Thiếu thông tin relay number hoặc GPIO pin' });
    }
    
    const device = await database.get(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
      [espId, req.session.userId]
    );
    
    if (!device) {
      return res.status(404).json({ error: 'Thiết bị không tồn tại' });
    }
    
    // Kiểm tra GPIO pin đã được sử dụng chưa
    const existingPin = await database.get(
      'SELECT * FROM relays WHERE device_id = ? AND gpio_pin = ? AND relay_number != ? AND is_active = 1',
      [espId, gpio_pin, relay_number]
    );
    
    if (existingPin) {
      return res.status(409).json({ error: 'GPIO ' + gpio_pin + ' đã được sử dụng bởi relay khác' });
    }
    
    // Cập nhật GPIO pin
    await database.run(
      'UPDATE relays SET gpio_pin = ? WHERE device_id = ? AND relay_number = ?',
      [gpio_pin, espId, relay_number]
    );
    
    console.log(`🔄 Updated pin config for ${espId} relay ${relay_number}: GPIO ${gpio_pin}`);
    
    // Gửi cấu hình mới đến ESP32
    sendConfigToESP(espId);
    
    res.json({ 
      ok: true, 
      message: `Đã cập nhật GPIO pin cho relay ${relay_number} thành ${gpio_pin}`
    });
    
  } catch (error) {
    console.error('❌ Update pin config error:', error);
    res.status(500).json({ error: 'Lỗi server khi cập nhật cấu hình pin' });
  }
});

// ==================== SYSTEM STATUS API ====================
app.get('/api/system/status', requireAuth, async (req, res) => {
  try {
    const totalUsersResult = await database.get('SELECT COUNT(*) as count FROM users');
    const totalDevicesResult = await database.get('SELECT COUNT(*) as count FROM devices');
    const totalRelaysResult = await database.get('SELECT COUNT(*) as count FROM relays WHERE is_active = 1');
    const userDeviceCountResult = await database.get(
      'SELECT COUNT(*) as count FROM devices WHERE user_id = ?',
      [req.session.userId]
    );
    const userSessionCountResult = await database.get(
      'SELECT session_count FROM users WHERE id = ?',
      [req.session.userId]
    );
    
    const totalUsers = totalUsersResult ? totalUsersResult.count : 0;
    const totalDevices = totalDevicesResult ? totalDevicesResult.count : 0;
    const totalRelays = totalRelaysResult ? totalRelaysResult.count : 0;
    const userDeviceCount = userDeviceCountResult ? userDeviceCountResult.count : 0;
    const userSessionCount = userSessionCountResult ? (userSessionCountResult.session_count || 0) : 0;
    
    res.json({
      ok: true,
      system: {
        totalUsers: totalUsers,
        totalDevices: totalDevices,
        totalRelays: totalRelays,
        mqttConnected: mqttClient ? mqttClient.connected : false
      },
      user: {
        username: req.session.username,
        deviceCount: userDeviceCount,
        sessionCount: userSessionCount
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ System status error:', error);
    res.status(500).json({ 
      error: 'Lỗi server khi lấy trạng thái hệ thống',
      details: error.message 
    });
  }
});

// ==================== HELPER FUNCTIONS ====================
async function sendConfigToESP(espId) {
  try {
    if (!mqttClient || !mqttClient.connected) {
      console.log(`⚠️ MQTT not connected, cannot send config to ${espId}`);
      return;
    }
    
    const relays = await database.all(
      `SELECT r.relay_number, r.name, r.gpio_pin, r.relay_type, r.icon, 
              COALESCE(rs.state, 0) as last_state
       FROM relays r 
       LEFT JOIN relay_states rs ON r.device_id = rs.device_id AND r.relay_number = rs.relay_number
       WHERE r.device_id = ? AND r.is_active = 1 
       ORDER BY r.relay_number`,
      [espId]
    );
    
    const configData = {
      espId: espId,
      relays: relays || [],
      timestamp: new Date().toISOString(),
      type: 'CONFIG_UPDATE'
    };
    
    mqttClient.publish(`esp/${espId}/config`, JSON.stringify(configData), { qos: 1 });
    console.log(`📤 Sent dynamic config to ESP ${espId}: ${relays.length} relays`);
    
  } catch (error) {
    console.error(`❌ Error sending config to ESP ${espId}:`, error);
  }
}

// ==================== MQTT MESSAGE HANDLER ====================
if (mqttClient) {
  mqttClient.on('message', async (topic, message) => {
    try {
      const messageStr = message.toString();
      
      if (topic.endsWith('/auth')) {
        const espId = topic.split('/')[1];
        
        try {
          const authData = JSON.parse(messageStr);
          console.log(`🔐 Auth request from ESP: ${espId}`, authData);
          
          if (authData.apiKey && authData.espId) {
            const apiKeyRow = await database.get(
              'SELECT user_id FROM api_keys WHERE api_key = ?',
              [authData.apiKey]
            );
            
            if (apiKeyRow) {
              const device = await database.get(
                'SELECT * FROM devices WHERE id = ? AND user_id = ?',
                [authData.espId, apiKeyRow.user_id]
              );
              
              if (device) {
                console.log(`✅ ESP ${authData.espId} authenticated successfully`);
                
                await database.run(
                  'UPDATE devices SET last_seen = ?, status = ? WHERE id = ?',
                  [new Date().toISOString(), 'online', authData.espId]
                );
                
                // Gửi cấu hình hiện tại ngay sau khi xác thực
                sendConfigToESP(authData.espId);
                
                mqttClient.publish(`esp/${authData.espId}/auth_response`, JSON.stringify({
                  status: 'success',
                  message: 'Authentication successful',
                  authenticated: true,
                  timestamp: Date.now()
                }), { qos: 1 });
              } else {
                console.log(`❌ ESP ${authData.espId} authentication failed - device not registered to user`);
                mqttClient.publish(`esp/${authData.espId}/auth_response`, JSON.stringify({
                  status: 'error',
                  message: 'Device not registered to this user',
                  authenticated: false
                }), { qos: 1 });
              }
            } else {
              console.log(`❌ ESP ${authData.espId} authentication failed - invalid API key`);
              mqttClient.publish(`esp/${authData.espId}/auth_response`, JSON.stringify({
                status: 'error',
                message: 'Invalid API key',
                authenticated: false
              }), { qos: 1 });
            }
          }
        } catch (parseError) {
          console.error(`❌ Failed to parse auth message from ESP ${espId}:`, parseError);
        }
        
      } else if (topic.endsWith('/status')) {
        const espId = topic.split('/')[1];
        console.log(`📊 Status from ESP ${espId}: ${messageStr}`);
        
        try {
          const statusData = JSON.parse(messageStr);
          if (statusData.espId) {
            await database.run(
              'UPDATE devices SET last_seen = ?, status = ? WHERE id = ?',
              [new Date().toISOString(), 'online', statusData.espId]
            );
            
            io.emit('esp_status', { 
              id: statusData.espId, 
              status: messageStr,
              timestamp: Date.now()
            });
          }
        } catch (e) {
          io.emit('esp_status', { 
            id: espId, 
            status: messageStr,
            timestamp: Date.now()
          });
        }
        
      } else if (topic.endsWith('/heartbeat')) {
        const espId = topic.split('/')[1];
        console.log(`💓 Heartbeat from ESP ${espId}`);
        
        await database.run(
          'UPDATE devices SET last_seen = ?, status = ? WHERE id = ?',
          [new Date().toISOString(), 'online', espId]
        );
        
        io.emit('esp_heartbeat', { 
          id: espId, 
          timestamp: Date.now()
        });
        
      } else if (topic.endsWith('/get_config') || topic.endsWith('/config_request')) {
        const espId = topic.split('/')[1];
        console.log(`📋 Config request from ESP ${espId}`);
        
        // Gửi cấu hình hiện tại
        sendConfigToESP(espId);
        
      } else if (topic.endsWith('/pin_config_update')) {
        const espId = topic.split('/')[1];
        
        try {
          const configData = JSON.parse(messageStr);
          console.log(`🔄 Pin config update from ESP ${espId}:`, configData);
          
          if (configData.espId && configData.relays) {
            for (const relay of configData.relays) {
              await database.run(
                'UPDATE relays SET gpio_pin = ? WHERE device_id = ? AND relay_number = ?',
                [relay.gpio_pin, espId, relay.relay_number]
              );
            }
            console.log(`✅ Updated pin config for ESP ${espId}`);
          }
        } catch (parseError) {
          console.error(`❌ Error parsing pin config update from ESP ${espId}:`, parseError);
        }
        
      } else if (topic.endsWith('/state_update') || topic.endsWith('/relay_state')) {
        const espId = topic.split('/')[1];
        
        try {
          const stateData = JSON.parse(messageStr);
          console.log(`🔄 Relay state update from ESP ${espId}:`, stateData);
          
          if (stateData.espId && stateData.relays) {
            for (const [relayNum, state] of Object.entries(stateData.relays)) {
              await database.run(
                `INSERT OR REPLACE INTO relay_states (device_id, relay_number, state, last_updated) 
                 VALUES (?, ?, ?, ?)`,
                [espId, parseInt(relayNum), state ? 1 : 0, new Date().toISOString()]
              );
            }
            console.log(`💾 Saved multiple relay states for ESP ${espId}`);
            
            io.emit('esp_relay_states', {
              id: espId,
              states: stateData.relays,
              timestamp: Date.now()
            });
          } else if (stateData.espId && stateData.relay !== undefined && stateData.state !== undefined) {
            await database.run(
              `INSERT OR REPLACE INTO relay_states (device_id, relay_number, state, last_updated) 
               VALUES (?, ?, ?, ?)`,
              [espId, stateData.relay, stateData.state ? 1 : 0, new Date().toISOString()]
            );
            
            console.log(`💾 Saved single relay state: ESP ${espId} relay ${stateData.relay} = ${stateData.state}`);
            
            io.emit('relay_state_updated', {
              deviceId: espId,
              relayNumber: stateData.relay,
              state: stateData.state,
              timestamp: Date.now()
            });
          }
        } catch (parseError) {
          console.error(`❌ Error parsing state update from ESP ${espId}:`, parseError);
        }
      }
    } catch (error) {
      console.error('❌ Error processing MQTT message:', error);
    }
  });
}

// ==================== SOCKET.IO CONNECTIONS ====================
io.on('connection', (socket) => {
  console.log('🔌 Client connected via Socket.IO:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected:', socket.id);
  });
});

// ==================== HEALTH CHECK & ROUTES ====================
app.get('/api/health', (req, res) => {
  const healthStatus = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    mqtt: {
      connected: mqttClient ? mqttClient.connected : false,
      broker: mqttClient ? (mqttClient.options?.host || 'unknown') : 'not initialized',
      port: mqttClient ? (mqttClient.options?.port || 'unknown') : 'not initialized',
      clientId: mqttClient ? (mqttClient.options?.clientId || 'unknown') : 'not initialized',
      reconnecting: mqttClient ? (mqttClient.reconnecting || false) : false
    },
    database: 'connected',
    environment: process.env.NODE_ENV || 'development'
  };
  
  res.json(healthStatus);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use((error, req, res, next) => {
  console.error('🚨 Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, async () => {
  console.log('\n=========================================');
  console.log('🚀 ESP32 Control Server Started!');
  console.log(`📍 http://localhost:${PORT}`);
  console.log('📡 MQTT Broker: 160.250.180.121:1883');
  console.log('🔧 CORS: ENABLED');
  console.log('💾 Database: SQLite3');
  console.log('🔐 API Key Authentication: ENABLED');
  console.log('🔄 Dynamic Relay Management: ENABLED (1-50+ relays)');
  console.log('💾 Relay State Persistence: ENABLED');
  console.log('🔧 Dynamic Pin Configuration: ENABLED');
  console.log('💾 Toggle-All State Persistence: ENABLED');
  
  try {
    const userCount = await database.get('SELECT COUNT(*) as count FROM users');
    const deviceCount = await database.get('SELECT COUNT(*) as count FROM devices');
    const relayCount = await database.get('SELECT COUNT(*) as count FROM relays WHERE is_active = 1');
    console.log('👥 Total users:', userCount ? userCount.count : 0);
    console.log('📱 Total devices:', deviceCount ? deviceCount.count : 0);
    console.log('🔌 Total relays:', relayCount ? relayCount.count : 0);
  } catch (error) {
    console.log('📊 Database statistics: Loading...');
  }
  
  console.log('=========================================\n');
});

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server gracefully...');
  
  if (mqttClient) {
    mqttClient.end();
  }
  
  httpServer.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

export default app;