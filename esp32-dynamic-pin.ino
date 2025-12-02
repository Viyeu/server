/*
 * ESP32 MQTT Relay Controller - Dynamic Pin Configuration
 * Hỗ trợ thay đổi chân GPIO mà không cần nạp lại firmware
 * 
 * Tính năng:
 * - Cấu hình chân GPIO động qua MQTT
 * - Tự động nhận cấu hình từ server khi khởi động
 * - Xác thực API Key bảo mật
 * - Hỗ trợ đến 50 relay
 * - Active LOW/HIGH configurable
 * - Real-time status reporting
 * 
 * Author: ESP32 Control System
 * Version: 3.0-DYNAMIC
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// ==================== CẤU HÌNH THAY ĐỔI ĐƯỢC ====================
const char* WIFI_SSID = "sangit";
const char* WIFI_PASS = "88888888";
const char* MQTT_BROKER = "160.250.180.121";
const int MQTT_PORT = 1883;
const char* CLIENT_ID = "admin";  // Thay đổi theo thiết bị
const char* API_KEY = "ak_6dfe20330fb701e9e4aab7a3a024a205d86ccec1ef1512ce_miaf3i65";  // Thay bằng API Key thật

// ==================== CẤU HÌNH HỆ THỐNG ====================
#define MAX_RELAYS 50
#define JSON_BUFFER_SIZE 4096

// ==================== CẤU TRÚC DỮ LIỆU RELAY ====================
struct RelayConfig {
    int number;
    String name;
    int gpio_pin;
    String relay_type;
    String icon;
    bool state;
    bool initialized;
};

// ==================== BIẾN TOÀN CỤC ====================
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

RelayConfig relays[MAX_RELAYS];
int relayCount = 0;
bool configLoaded = false;
bool authenticated = false;
unsigned long lastConfigRequest = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastReconnectAttempt = 0;

// ==================== TOPICS MQTT ====================
char topicCmd[50];
char topicStatus[50];
char topicAuth[50];
char topicAuthResponse[50];
char topicConfig[50];
char topicConfigRequest[50];
char topicStateUpdate[50];

// ==================== KHAI BÁO HÀM ====================
void setupTopics();
void initializeRelays();
void setRelay(int relayNumber, bool state);
void setAllRelays(bool state);
void parseRelayConfig(const char* jsonConfig);
void requestConfig();
void sendPinConfigUpdate();
void setupWiFi();
void setupMQTT();
void reconnectMQTT();
void mqttCallback(char* topic, byte* payload, unsigned int length);
void handleCommand(const char* payload);
void sendStatus(const char* message);
void sendDetailedStatus();
void sendHeartbeat();
void authenticate();
void printSystemInfo();

// ==================== THIẾT LẬP TOPICS ====================
void setupTopics() {
    snprintf(topicCmd, sizeof(topicCmd), "esp/%s/cmd", CLIENT_ID);
    snprintf(topicStatus, sizeof(topicStatus), "esp/%s/status", CLIENT_ID);
    snprintf(topicAuth, sizeof(topicAuth), "esp/%s/auth", CLIENT_ID);
    snprintf(topicAuthResponse, sizeof(topicAuthResponse), "esp/%s/auth_response", CLIENT_ID);
    snprintf(topicConfig, sizeof(topicConfig), "esp/%s/config", CLIENT_ID);
    snprintf(topicConfigRequest, sizeof(topicConfigRequest), "esp/%s/config_request", CLIENT_ID);
    snprintf(topicStateUpdate, sizeof(topicStateUpdate), "esp/%s/state_update", CLIENT_ID);
    
    Serial.println("📡 Topics MQTT:");
    Serial.println("  " + String(topicCmd));
    Serial.println("  " + String(topicStatus));
    Serial.println("  " + String(topicConfig));
}

// ==================== KHỞI TẠO RELAY ====================
void initializeRelays() {
    Serial.println("🔌 Khởi tạo relay từ cấu hình...");
    
    for (int i = 0; i < relayCount; i++) {
        if (relays[i].gpio_pin > 0 && relays[i].gpio_pin <= 39) {
            pinMode(relays[i].gpio_pin, OUTPUT);
            
            if (relays[i].relay_type == "LOW") {
                digitalWrite(relays[i].gpio_pin, HIGH); // Active LOW: Bắt đầu với TẮT
            } else {
                digitalWrite(relays[i].gpio_pin, LOW);  // Active HIGH: Bắt đầu với TẮT
            }
            
            relays[i].state = false;
            relays[i].initialized = true;
            
            Serial.printf("  ✅ Relay %d: %s (GPIO %d, %s)\n", 
                         relays[i].number, 
                         relays[i].name.c_str(),
                         relays[i].gpio_pin,
                         relays[i].relay_type.c_str());
        } else {
            Serial.printf("  ❌ Relay %d: GPIO %d không hợp lệ\n", 
                         relays[i].number, relays[i].gpio_pin);
            relays[i].initialized = false;
        }
    }
    Serial.printf("✅ Đã khởi tạo %d/%d relay\n", relayCount, MAX_RELAYS);
}

// ==================== ĐIỀU KHIỂN RELAY ====================
void setRelay(int relayNumber, bool state) {
    for (int i = 0; i < relayCount; i++) {
        if (relays[i].number == relayNumber && relays[i].initialized) {
            if (relays[i].relay_type == "LOW") {
                digitalWrite(relays[i].gpio_pin, state ? LOW : HIGH);
            } else {
                digitalWrite(relays[i].gpio_pin, state ? HIGH : LOW);
            }
            
            relays[i].state = state;
            
            Serial.printf("🔌 Relay %d (%s): %s (GPIO %d)\n", 
                         relayNumber,
                         relays[i].name.c_str(),
                         state ? "ON" : "OFF",
                         relays[i].gpio_pin);
            
            // Gửi cập nhật trạng thái
            sendDetailedStatus();
            return;
        }
    }
    Serial.printf("❌ Không tìm thấy relay %d\n", relayNumber);
}

void setAllRelays(bool state) {
    for (int i = 0; i < relayCount; i++) {
        if (relays[i].initialized) {
            setRelay(relays[i].number, state);
        }
    }
    Serial.printf("🔌 Tất cả relay: %s\n", state ? "BẬT" : "TẮT");
}

// ==================== XỬ LÝ CẤU HÌNH ĐỘNG ====================
void parseRelayConfig(const char* jsonConfig) {
    Serial.println("📋 Đang phân tích cấu hình relay động...");
    
    DynamicJsonDocument doc(JSON_BUFFER_SIZE);
    DeserializationError error = deserializeJson(doc, jsonConfig);
    
    if (error) {
        Serial.printf("❌ Lỗi parse JSON config: %s\n", error.c_str());
        return;
    }
    
    if (!doc.containsKey("relays")) {
        Serial.println("❌ Không tìm thấy relay config trong JSON");
        return;
    }
    
    JsonArray relayArray = doc["relays"];
    relayCount = 0;
    
    // Reset tất cả relay cũ trước
    for (int i = 0; i < MAX_RELAYS; i++) {
        if (relays[i].initialized && relays[i].gpio_pin > 0) {
            // Tắt relay cũ trước khi thay đổi cấu hình
            digitalWrite(relays[i].gpio_pin, relays[i].relay_type == "LOW" ? HIGH : LOW);
        }
        relays[i].initialized = false;
    }
    
    // Load cấu hình mới từ JSON
    for (JsonObject relay : relayArray) {
        if (relayCount >= MAX_RELAYS) {
            Serial.println("⚠️ Đạt tối đa số relay, bỏ qua phần còn lại");
            break;
        }
        
        int relayNum = relay["relay_number"];
        String name = relay["name"].as<String>();
        int gpioPin = relay["gpio_pin"];
        String relayType = relay["relay_type"].as<String>();
        String icon = relay["icon"].as<String>();
        bool lastState = relay.containsKey("last_state") ? relay["last_state"] : false;
        
        // Validate GPIO pin
        if (gpioPin < 0 || gpioPin > 39) {
            Serial.printf("❌ Relay %d: GPIO %d không hợp lệ, bỏ qua\n", relayNum, gpioPin);
            continue;
        }
        
        relays[relayCount].number = relayNum;
        relays[relayCount].name = name;
        relays[relayCount].gpio_pin = gpioPin;
        relays[relayCount].relay_type = relayType;
        relays[relayCount].icon = icon;
        relays[relayCount].state = lastState;
        relays[relayCount].initialized = false; // Sẽ được khởi tạo sau
        
        relayCount++;
        
        Serial.printf("  📝 Relay %d: %s -> GPIO %d (%s)\n", 
                     relayNum, name.c_str(), gpioPin, relayType.c_str());
    }
    
    // Khởi tạo phần cứng với cấu hình mới
    initializeRelays();
    configLoaded = true;
    
    Serial.printf("✅ Đã tải cấu hình %d relay từ server\n", relayCount);
    
    // Gửi xác nhận cấu hình
    sendStatus("CONFIG_LOADED");
    
    // Gửi cập nhật pin config
    sendPinConfigUpdate();
}

void requestConfig() {
    if (millis() - lastConfigRequest < 5000) {
        return; // Chỉ gửi mỗi 5 giây
    }
    
    Serial.println("📡 Yêu cầu cấu hình từ server...");
    
    StaticJsonDocument<200> reqDoc;
    reqDoc["espId"] = CLIENT_ID;
    reqDoc["apiKey"] = API_KEY;
    reqDoc["timestamp"] = millis();
    reqDoc["type"] = "CONFIG_REQUEST";
    
    String reqMsg;
    serializeJson(reqDoc, reqMsg);
    
    if (mqttClient.publish(topicConfigRequest, reqMsg.c_str())) {
        Serial.println("  📤 Đã gửi yêu cầu cấu hình");
        lastConfigRequest = millis();
    } else {
        Serial.println("  ❌ Lỗi gửi yêu cầu cấu hình");
    }
}

void sendPinConfigUpdate() {
    Serial.println("🔄 Gửi cập nhật cấu hình pin...");
    
    DynamicJsonDocument doc(JSON_BUFFER_SIZE);
    doc["espId"] = CLIENT_ID;
    doc["timestamp"] = millis();
    doc["type"] = "PIN_CONFIG_UPDATE";
    
    JsonArray relayArray = doc.createNestedArray("relays");
    for (int i = 0; i < relayCount; i++) {
        JsonObject relay = relayArray.createNestedObject();
        relay["relay_number"] = relays[i].number;
        relay["gpio_pin"] = relays[i].gpio_pin;
        relay["name"] = relays[i].name;
        relay["relay_type"] = relays[i].relay_type;
        relay["state"] = relays[i].state;
    }
    
    String msg;
    serializeJson(doc, msg);
    
    if (mqttClient.publish(topicStateUpdate, msg.c_str())) {
        Serial.println("  ✅ Đã gửi cập nhật cấu hình pin");
    }
}

// ==================== GỬI TRẠNG THÁI ====================
void sendStatus(const char* message) {
    StaticJsonDocument<300> statusDoc;
    statusDoc["espId"] = CLIENT_ID;
    statusDoc["status"] = message;
    statusDoc["timestamp"] = millis();
    statusDoc["configLoaded"] = configLoaded;
    statusDoc["relayCount"] = relayCount;
    statusDoc["heap"] = ESP.getFreeHeap();
    statusDoc["rssi"] = WiFi.RSSI();
    
    String statusMsg;
    serializeJson(statusDoc, statusMsg);
    
    if (mqttClient.publish(topicStatus, statusMsg.c_str())) {
        Serial.printf("📊 Trạng thái: %s\n", message);
    }
}

void sendDetailedStatus() {
    DynamicJsonDocument doc(JSON_BUFFER_SIZE);
    doc["espId"] = CLIENT_ID;
    doc["timestamp"] = millis();
    doc["configLoaded"] = configLoaded;
    doc["authenticated"] = authenticated;
    doc["relayCount"] = relayCount;
    doc["heap"] = ESP.getFreeHeap();
    doc["rssi"] = WiFi.RSSI();
    doc["version"] = "3.0-DYNAMIC";
    
    JsonObject relayStates = doc.createNestedObject("relays");
    for (int i = 0; i < relayCount; i++) {
        if (relays[i].initialized) {
            char relayKey[10];
            snprintf(relayKey, sizeof(relayKey), "relay%d", relays[i].number);
            relayStates[relayKey] = relays[i].state ? "ON" : "OFF";
        }
    }
    
    String statusMsg;
    serializeJson(doc, statusMsg);
    
    if (mqttClient.publish(topicStatus, statusMsg.c_str())) {
        Serial.println("📊 Đã gửi trạng thái chi tiết");
    }
}

void sendHeartbeat() {
    if (authenticated && configLoaded) {
        sendStatus("HEARTBEAT");
    } else if (authenticated) {
        sendStatus("AUTHENTICATED_WAITING_CONFIG");
    }
}

// ==================== XÁC THỰC ====================
void authenticate() {
    Serial.println("🔐 Đang xác thực với server...");
    
    StaticJsonDocument<300> authDoc;
    authDoc["espId"] = CLIENT_ID;
    authDoc["apiKey"] = API_KEY;
    authDoc["chipModel"] = ESP.getChipModel();
    authDoc["firmware"] = "3.0-DYNAMIC-PIN";
    authDoc["timestamp"] = millis();
    authDoc["mac"] = WiFi.macAddress();
    
    String authMsg;
    serializeJson(authDoc, authMsg);
    
    if (mqttClient.publish(topicAuth, authMsg.c_str())) {
        Serial.println("  📤 Đã gửi yêu cầu xác thực");
    } else {
        Serial.println("  ❌ Lỗi gửi yêu cầu xác thực");
    }
}

// ==================== XỬ LÝ LỆNH MQTT ====================
void handleCommand(const char* payload) {
    Serial.printf("📨 Nhận lệnh: %s\n", payload);
    
    DynamicJsonDocument doc(512);
    DeserializationError error = deserializeJson(doc, payload);
    
    if (error) {
        Serial.println("❌ Lỗi parse JSON command");
        sendStatus("ERROR: Invalid JSON");
        return;
    }
    
    // Kiểm tra API Key
    if (!doc.containsKey("apiKey") || strcmp(doc["apiKey"], API_KEY) != 0) {
        Serial.println("❌ API Key không hợp lệ");
        sendStatus("ERROR: Invalid API Key");
        return;
    }
    
    Serial.println("✅ API Key hợp lệ");
    
    // Xử lý lệnh ALL
    if (doc.containsKey("command")) {
        const char* command = doc["command"];
        
        if (strcmp(command, "ALL:ON") == 0) {
            setAllRelays(true);
            sendStatus("ALL_ON");
            return;
        } 
        else if (strcmp(command, "ALL:OFF") == 0) {
            setAllRelays(false);
            sendStatus("ALL_OFF");
            return;
        }
        else if (strcmp(command, "GET_CONFIG") == 0) {
            requestConfig();
            sendStatus("CONFIG_REQUESTED");
            return;
        }
        else if (strcmp(command, "GET_STATUS") == 0) {
            sendDetailedStatus();
            return;
        }
        else if (strcmp(command, "RESTART") == 0) {
            sendStatus("RESTARTING");
            delay(1000);
            ESP.restart();
            return;
        }
    }
    
    // Xử lý lệnh relay riêng lẻ
    if (doc.containsKey("relay") && doc.containsKey("value")) {
        int relayNum = doc["relay"];
        bool value = doc["value"];
        
        if (relayNum >= 1 && relayNum <= MAX_RELAYS) {
            setRelay(relayNum, value);
            sendStatus("RELAY_UPDATED");
        } else {
            Serial.printf("❌ Số relay không hợp lệ: %d\n", relayNum);
            sendStatus("ERROR: Invalid relay number");
        }
    }
}

// ==================== CALLBACK MQTT ====================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
    // Chuyển payload thành string
    char message[2048];
    if (length < sizeof(message)) {
        strncpy(message, (char*)payload, length);
        message[length] = '\0';
    } else {
        strncpy(message, (char*)payload, sizeof(message) - 1);
        message[sizeof(message) - 1] = '\0';
    }
    
    Serial.printf("📨 Nhận MQTT [%s]: %s\n", topic, message);
    
    // Xử lý phản hồi xác thực
    if (strcmp(topic, topicAuthResponse) == 0) {
        DynamicJsonDocument responseDoc(300);
        DeserializationError error = deserializeJson(responseDoc, message);
        
        if (!error && responseDoc["status"] == "success") {
            authenticated = true;
            Serial.println("✅ Xác thực thành công!");
            
            // Yêu cầu cấu hình ngay sau khi xác thực
            requestConfig();
            sendStatus("AUTHENTICATED");
        } else {
            authenticated = false;
            const char* errorMsg = responseDoc["message"] | "Unknown error";
            Serial.printf("❌ Xác thực thất bại: %s\n", errorMsg);
            sendStatus("AUTH_FAILED");
        }
        return;
    }
    
    // Xử lý cấu hình relay động
    if (strcmp(topic, topicConfig) == 0) {
        Serial.println("🔄 Nhận cấu hình relay mới từ server");
        parseRelayConfig(message);
        return;
    }
    
    // Chỉ xử lý lệnh điều khiển nếu đã xác thực và có cấu hình
    if (strcmp(topic, topicCmd) == 0) {
        if (!authenticated) {
            Serial.println("⚠️ Chưa xác thực, bỏ qua lệnh");
            sendStatus("ERROR: Not authenticated");
            return;
        }
        
        if (!configLoaded) {
            Serial.println("⚠️ Chưa có cấu hình, bỏ qua lệnh");
            sendStatus("ERROR: No config loaded");
            return;
        }
        
        handleCommand(message);
    }
}

// ==================== KẾT NỐI LẠI MQTT ====================
void reconnectMQTT() {
    unsigned long now = millis();
    
    if (now - lastReconnectAttempt < 5000) {
        return;
    }
    
    lastReconnectAttempt = now;
    
    Serial.print("🔄 Đang kết nối MQTT...");
    
    if (mqttClient.connect(CLIENT_ID)) {
        Serial.println("✅ MQTT connected!");
        
        // Subscribe các topic
        if (mqttClient.subscribe(topicCmd)) {
            Serial.println("  ✅ Subscribed to CMD topic");
        }
        if (mqttClient.subscribe(topicAuthResponse)) {
            Serial.println("  ✅ Subscribed to AUTH_RESPONSE topic");
        }
        if (mqttClient.subscribe(topicConfig)) {
            Serial.println("  ✅ Subscribed to CONFIG topic");
        }
        
        // Xác thực ngay sau khi kết nối
        authenticate();
        
    } else {
        Serial.printf("❌ MQTT failed, rc=%d\n", mqttClient.state());
    }
}

// ==================== THIẾT LẬP WIFI ====================
void setupWiFi() {
    Serial.printf("📶 Đang kết nối WiFi: %s", WIFI_SSID);
    
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.persistent(true);
    
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) {
        delay(500);
        Serial.print(".");
        attempts++;
        if (attempts % 10 == 0) Serial.println();
    }
    
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\n✅ WiFi connected!");
        Serial.printf("📡 IP: %s\n", WiFi.localIP().toString().c_str());
        Serial.printf("📶 RSSI: %d dBm\n", WiFi.RSSI());
        Serial.printf("📡 MAC: %s\n", WiFi.macAddress().c_str());
    } else {
        Serial.println("\n❌ Kết nối WiFi thất bại!");
        Serial.println("Kiểm tra SSID/password và tín hiệu WiFi");
    }
}

// ==================== THIẾT LẬP MQTT ====================
void setupMQTT() {
    mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
    mqttClient.setCallback(mqttCallback);
    mqttClient.setKeepAlive(60);
    mqttClient.setSocketTimeout(30);
    mqttClient.setBufferSize(2048);
}

// ==================== THÔNG TIN HỆ THỐNG ====================
void printSystemInfo() {
    Serial.println("\n=========================================");
    Serial.println("🚀 ESP32 Dynamic Relay Controller");
    Serial.println("🔌 Cấu hình chân GPIO ĐỘNG qua MQTT");
    Serial.println("=========================================");
    Serial.printf("Chip: %s\n", ESP.getChipModel());
    Serial.printf("Cores: %d\n", ESP.getChipCores());
    Serial.printf("CPU Freq: %d MHz\n", ESP.getCpuFreqMHz());
    Serial.printf("Flash Size: %d MB\n", ESP.getFlashChipSize() / (1024 * 1024));
    Serial.printf("Free Heap: %d bytes\n", ESP.getFreeHeap());
    Serial.printf("Device ID: %s\n", CLIENT_ID);
    Serial.printf("WiFi: %s\n", WIFI_SSID);
    Serial.printf("MQTT: %s:%d\n", MQTT_BROKER, MQTT_PORT);
    Serial.println("=========================================\n");
}

// ==================== SETUP ====================
void setup() {
    Serial.begin(115200);
    delay(1000);
    
    // Hiển thị thông tin hệ thống
    printSystemInfo();
    
    // Thiết lập topics MQTT
    setupTopics();
    
    // Kết nối WiFi
    setupWiFi();
    
    // Thiết lập MQTT
    setupMQTT();
    
    Serial.println("✅ Khởi động hoàn tất! Đang kết nối MQTT...");
    
    // Gửi trạng thái khởi động
    sendStatus("BOOT_COMPLETE");
}

// ==================== LOOP CHÍNH ====================
void loop() {
    // Duy trì kết nối MQTT
    if (!mqttClient.connected()) {
        reconnectMQTT();
    }
    mqttClient.loop();
    
    unsigned long now = millis();
    
    // Gửi heartbeat mỗi 30 giây
    if (now - lastHeartbeat > 30000) {
        sendHeartbeat();
        lastHeartbeat = now;
        
        // Hiển thị thông tin hệ thống mỗi 5 phút
        static unsigned long lastSysInfo = 0;
        if (now - lastSysInfo > 300000) {
            Serial.printf("🔧 System Info - Heap: %d, RSSI: %d dBm\n", 
                         ESP.getFreeHeap(), WiFi.RSSI());
            lastSysInfo = now;
        }
    }
    
    // Nếu đã xác thực nhưng chưa có cấu hình, yêu cầu mỗi 10 giây
    if (authenticated && !configLoaded && now - lastConfigRequest > 10000) {
        requestConfig();
    }
    
    delay(100);
}