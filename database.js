// database.js - Updated for dynamic relay management and toggle-all state persistence
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class Database {
    constructor() {
        this.db = null;
        this.init();
    }

    init() {
        const dbPath = path.join(__dirname, 'esp32_control.db');
        
        this.db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('❌ Database connection error:', err);
                return;
            }
            console.log('✅ Connected to SQLite database');
            this.createTables();
        });
    }

    createTables() {
        this.db.serialize(() => {
            // Users table
            this.db.run(`CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_login DATETIME,
                session_count INTEGER DEFAULT 0
            )`);

            // API Keys table
            this.db.run(`CREATE TABLE IF NOT EXISTS api_keys (
                user_id TEXT PRIMARY KEY,
                api_key TEXT UNIQUE NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )`);

            // Devices table
            this.db.run(`CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                label TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_seen DATETIME,
                status TEXT DEFAULT 'offline',
                max_relays INTEGER DEFAULT 10,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )`);

            // Relays table - UPDATED: removed relay_number limit
            this.db.run(`CREATE TABLE IF NOT EXISTS relays (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                relay_number INTEGER NOT NULL,
                name TEXT NOT NULL,
                gpio_pin INTEGER NOT NULL,
                relay_type TEXT DEFAULT 'LOW',
                icon TEXT DEFAULT 'fa-sliders-h',
                is_active BOOLEAN DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE,
                UNIQUE(device_id, relay_number)
            )`);

            // Relay States table
            this.db.run(`CREATE TABLE IF NOT EXISTS relay_states (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                relay_number INTEGER NOT NULL,
                state BOOLEAN NOT NULL DEFAULT 0,
                last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE,
                UNIQUE(device_id, relay_number)
            )`);

            // Toggle All States table - NEW: for storing toggle-all state
            this.db.run(`CREATE TABLE IF NOT EXISTS toggle_all_states (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                state BOOLEAN NOT NULL DEFAULT 0,
                last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE,
                UNIQUE(device_id)
            )`);

            // Create indexes
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id)`);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_relays_device_id ON relays(device_id)`);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)`);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_relay_states_device_id ON relay_states(device_id)`);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_relay_states_device_relay ON relay_states(device_id, relay_number)`);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_toggle_all_states_device_id ON toggle_all_states(device_id)`);
        });
    }

    // Promise-based query methods
    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, changes: this.changes });
            });
        });
    }

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    close() {
        return new Promise((resolve, reject) => {
            this.db.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}

// Export database instance
const database = new Database();
export default database;