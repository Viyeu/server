// script.js - Complete ESP32 Control System with auto-sync configuration
const socket = io();
let userApiKey = '';
let userDevices = [];
let currentEditingRelay = null;
let currentAddingRelayDeviceId = '';
let deviceRelays = new Map();
let currentAddMode = 'single'; // 'single' hoặc 'multiple'
const MAX_RELAYS_PER_DEVICE = 50;

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', function() {
    checkAuth();
    initializeEventListeners();
    loadFormData();
    updateGenerateOptions();
    initializeAddRelayEvents();
});

function initializeEventListeners() {
    document.addEventListener('input', function(e) {
        if (e.target.id === 'wifiSSID' || e.target.id === 'codeEspId' || 
            e.target.id === 'mqttBroker' || e.target.id === 'mqttPort') {
            saveFormData();
        }
    });
}

function initializeAddRelayEvents() {
    // Thêm sự kiện cho các input trong multiple mode
    const multipleCountInput = document.getElementById('multipleRelayCount');
    const multiplePrefixInput = document.getElementById('multipleRelayPrefix');
    
    if (multipleCountInput) {
        multipleCountInput.addEventListener('input', updateMultipleRelayPreview);
    }
    if (multiplePrefixInput) {
        multiplePrefixInput.addEventListener('input', updateMultipleRelayPreview);
    }
}

function formatTimeAgo(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    
    if (minutes < 1) return 'Vừa xong';
    if (minutes < 60) return `${minutes} phút trước`;
    if (hours < 24) return `${hours} giờ trước`;
    return new Date(timestamp).toLocaleString('vi-VN');
}

// ==================== RELAY STATE PERSISTENCE FUNCTIONS ====================
async function loadRelayStates(espId) {
    try {
        const res = await fetch(`/api/esp/${espId}/relays/states`);
        if (res.ok) {
            const data = await res.json();
            if (data.ok && data.states) {
                updateRelayUIFromStates(espId, data.states);
                console.log(`✅ Loaded relay states for ${espId}:`, data.states);
            }
        }
    } catch (error) {
        console.error(`❌ Error loading relay states for ${espId}:`, error);
    }
}

function updateRelayUIFromStates(espId, states) {
    for (const [relayNumber, stateData] of Object.entries(states)) {
        const relayNum = parseInt(relayNumber);
        const isOn = stateData.state === true;
        updateRelayUI(espId, relayNum, isOn ? 1 : 0);
    }
    updateToggleAllButtonState(espId, states);
}

function updateToggleAllButtonState(espId, states) {
    const deviceItem = findDeviceItem(espId);
    if (!deviceItem) return;
    
    const toggleBtn = deviceItem.querySelector('.btn-toggle-all');
    if (!toggleBtn || !states) return;
    
    const allOn = Object.values(states).every(state => state.state === true);
    const allOff = Object.values(states).every(state => state.state === false);
    
    if (allOn) {
        toggleBtn.classList.add('on');
        toggleBtn.classList.remove('off');
        toggleBtn.title = "Tắt tất cả relay";
    } else if (allOff) {
        toggleBtn.classList.add('off');
        toggleBtn.classList.remove('on');
        toggleBtn.title = "Bật tất cả relay";
    } else {
        toggleBtn.classList.remove('on', 'off');
        toggleBtn.title = "Bật/tắt tất cả relay";
    }
}

async function saveRelayState(espId, relayNumber, state) {
    try {
        const res = await fetch(`/api/esp/${espId}/relays/${relayNumber}/state`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: state === 1 })
        });
        
        if (res.ok) {
            console.log(`💾 Saved relay state: ${espId} relay ${relayNumber} = ${state}`);
        } else {
            console.error(`❌ Failed to save relay state for ${espId}`);
        }
    } catch (error) {
        console.error('❌ Error saving relay state:', error);
    }
}

// ==================== TOGGLE ALL RELAYS ====================
async function toggleAllRelaysOfDevice(espId) {
    const button = event.currentTarget;
    
    if (button.disabled) return;
    button.disabled = true;
    
    const isCurrentlyOn = button.classList.contains('on');
    const command = isCurrentlyOn ? 'ALL:OFF' : 'ALL:ON';
    const newState = isCurrentlyOn ? 0 : 1;
    
    sendCommand(espId, command);
    
    const relays = deviceRelays.get(espId) || [];
    const savePromises = relays.map(relay => {
        updateRelayUI(espId, relay.relay_number, newState);
        return saveRelayState(espId, relay.relay_number, newState);
    });
    
    await Promise.all(savePromises);
    
    if (isCurrentlyOn) {
        button.classList.remove('on');
        button.classList.add('off');
        button.title = "Bật tất cả relay";
    } else {
        button.classList.remove('off');
        button.classList.add('on');
        button.title = "Tắt tất cả relay";
    }
    
    await saveToggleAllState(espId, !isCurrentlyOn);
    
    setTimeout(() => {
        button.disabled = false;
    }, 1000);
}

async function saveToggleAllState(espId, isOn) {
    try {
        const res = await fetch(`/api/esp/${espId}/toggle-all-state`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: isOn })
        });
        
        if (res.ok) {
            console.log(`💾 Saved toggle-all state for ${espId}: ${isOn}`);
        } else {
            console.error(`❌ Failed to save toggle-all state for ${espId}`);
        }
    } catch (error) {
        console.error('❌ Error saving toggle-all state:', error);
    }
}

async function loadToggleAllState(espId) {
    try {
        const res = await fetch(`/api/esp/${espId}/toggle-all-state`);
        if (res.ok) {
            const data = await res.json();
            if (data.ok && data.state !== undefined) {
                updateToggleAllButtonFromState(espId, data.state);
                return data.state;
            }
        }
    } catch (error) {
        console.error(`❌ Error loading toggle-all state for ${espId}:`, error);
    }
    return false;
}

function updateToggleAllButtonFromState(espId, isOn) {
    const deviceItem = findDeviceItem(espId);
    if (!deviceItem) return;
    
    const toggleBtn = deviceItem.querySelector('.btn-toggle-all');
    if (!toggleBtn) return;
    
    if (isOn) {
        toggleBtn.classList.add('on');
        toggleBtn.classList.remove('off');
        toggleBtn.title = "Tắt tất cả relay";
    } else {
        toggleBtn.classList.add('off');
        toggleBtn.classList.remove('on');
        toggleBtn.title = "Bật tất cả relay";
    }
}

// ==================== PIN SUGGESTIONS ====================
function showPinSuggestionsForAdd() {
    const suggestionsSection = document.getElementById('addRelayPinSuggestionsSection');
    const pinSuggestions = document.getElementById('addRelayPinSuggestions');
    
    if (!currentAddingRelayDeviceId) return;
    
    const usedPins = getUsedPinsForDevice(currentAddingRelayDeviceId);
    const currentPin = parseInt(document.getElementById('newRelayPin').value) || 0;
    
    const safePins = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33];
    const recommendedPins = [2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27];
    
    let html = '';
    safePins.forEach(pin => {
        const isUsed = usedPins.includes(pin);
        const isRecommended = recommendedPins.includes(pin);
        const isCurrent = pin === currentPin;
        const usedClass = isUsed ? 'used' : '';
        const recommendedClass = (!isUsed && isRecommended) ? 'recommended' : '';
        const currentClass = isCurrent ? 'selected' : '';
        
        html += `<div class="pin-suggestion ${usedClass} ${recommendedClass} ${currentClass}" 
                     onclick="${isUsed ? '' : `selectPinInAddModal(${pin})`}" 
                     title="${isUsed ? 'Đã được sử dụng' : isCurrent ? 'Đang sử dụng' : 'Nhấn để chọn'}">
            GPIO ${pin} 
            ${isRecommended && !isUsed ? '⭐' : ''}
            ${isCurrent ? '✓' : ''}
        </div>`;
    });
    
    pinSuggestions.innerHTML = html;
    suggestionsSection.style.display = 'block';
}

function selectPinInAddModal(pin) {
    document.getElementById('newRelayPin').value = pin;
    
    const suggestions = document.querySelectorAll('#addRelayPinSuggestions .pin-suggestion');
    suggestions.forEach(suggestion => {
        suggestion.classList.remove('selected');
        if (suggestion.textContent.includes(`GPIO ${pin}`)) {
            suggestion.classList.add('selected');
        }
    });
    
    setTimeout(() => {
        document.getElementById('addRelayPinSuggestionsSection').style.display = 'none';
    }, 500);
}

function showPinSuggestionsForEdit() {
    const suggestionsSection = document.getElementById('editRelayPinSuggestionsSection');
    const pinSuggestions = document.getElementById('editRelayPinSuggestions');
    
    if (!currentEditingRelay) return;
    
    const usedPins = getUsedPinsForDevice(currentEditingRelay.espId, currentEditingRelay.relayNumber);
    const currentPin = parseInt(document.getElementById('editRelayPin').value);
    
    const safePins = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33];
    const recommendedPins = [2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27];
    
    let html = '';
    safePins.forEach(pin => {
        const isUsed = usedPins.includes(pin);
        const isRecommended = recommendedPins.includes(pin);
        const isCurrent = pin === currentPin;
        const usedClass = isUsed ? 'used' : '';
        const recommendedClass = (!isUsed && isRecommended) ? 'recommended' : '';
        const currentClass = isCurrent ? 'selected' : '';
        
        html += `<div class="pin-suggestion ${usedClass} ${recommendedClass} ${currentClass}" 
                     onclick="${isUsed ? '' : `selectPinInEditModal(${pin})`}" 
                     title="${isUsed ? 'Đã được sử dụng' : isCurrent ? 'Đang sử dụng' : 'Nhấn để chọn'}">
            GPIO ${pin} 
            ${isRecommended && !isUsed ? '⭐' : ''}
            ${isCurrent ? '✓' : ''}
        </div>`;
    });
    
    pinSuggestions.innerHTML = html;
    suggestionsSection.style.display = 'block';
}

function selectPinInEditModal(pin) {
    document.getElementById('editRelayPin').value = pin;
    
    const suggestions = document.querySelectorAll('#editRelayPinSuggestions .pin-suggestion');
    suggestions.forEach(suggestion => {
        suggestion.classList.remove('selected');
        if (suggestion.textContent.includes(`GPIO ${pin}`)) {
            suggestion.classList.add('selected');
        }
    });
    
    setTimeout(() => {
        document.getElementById('editRelayPinSuggestionsSection').style.display = 'none';
    }, 500);
}

function getUsedPinsForDevice(espId, excludeRelayNumber = null) {
    const usedPins = [];
    if (deviceRelays.has(espId)) {
        const relays = deviceRelays.get(espId);
        relays.forEach(relay => {
            if (relay.gpio_pin && relay.relay_number !== excludeRelayNumber) {
                usedPins.push(relay.gpio_pin);
            }
        });
    }
    return usedPins;
}

// ==================== COMBINED ADD RELAY FUNCTIONS ====================
function changeAddMode(mode) {
    currentAddMode = mode;
    const singleDetails = document.getElementById('singleRelayDetails');
    const multipleDetails = document.getElementById('multipleRelayDetails');
    const multipleCountGroup = document.getElementById('multipleCountGroup');
    const addBtn = document.getElementById('addRelayBtn');
    
    if (mode === 'single') {
        singleDetails.style.display = 'block';
        multipleDetails.style.display = 'none';
        multipleCountGroup.style.display = 'none';
        addBtn.innerHTML = '<i class="fas fa-plus"></i> Thêm Relay';
        suggestNextRelayNumber(currentAddingRelayDeviceId);
    } else {
        singleDetails.style.display = 'none';
        multipleDetails.style.display = 'block';
        multipleCountGroup.style.display = 'block';
        addBtn.innerHTML = '<i class="fas fa-layer-group"></i> Thêm Nhiều Relay';
        updateMultipleRelayPreview();
    }
}

function updateMultipleRelayPreview() {
    const count = parseInt(document.getElementById('multipleRelayCount').value) || 5;
    const prefix = document.getElementById('multipleRelayPrefix').value || 'Relay';
    const previewList = document.getElementById('previewList');
    
    let html = '';
    for (let i = 1; i <= count; i++) {
        const relayName = `${prefix} ${i}`;
        html += `<div class="preview-item"><i class="fas fa-sliders-h"></i> ${relayName}</div>`;
    }
    
    previewList.innerHTML = html;
}

// ==================== CODE DOWNLOAD FUNCTIONS ====================
function loadCodeGeneratorWithDevice() {
    if (userDevices.length === 0) {
        showNotification('<i class="fas fa-exclamation-circle"></i> Vui lòng thêm thiết bị trước khi tải code', 'warning');
        showAddDeviceModal();
        return;
    }

    showTab('codegen');
    
    if (userDevices.length > 0) {
        const firstDevice = userDevices[0];
        document.getElementById('codeEspId').value = firstDevice.id;
        updateCodeGeneratorWithDynamicRelays(firstDevice.id);
        showNotification(`<i class="fas fa-check-circle"></i> Đã điền ESP ID: ${firstDevice.id}`, 'success');
    }
    
    if (!userApiKey) {
        getUserApiKey();
    }
    
    setTimeout(() => {
        document.getElementById('codegenTab').scrollIntoView({ behavior: 'smooth' });
    }, 500);
}

function downloadCodeForDevice(espId) {
    const device = userDevices.find(d => d.id === espId);
    if (!device) {
        showNotification('<i class="fas fa-exclamation-circle"></i> Không tìm thấy thiết bị', 'error');
        return;
    }

    showTab('codegen');
    document.getElementById('codeEspId').value = device.id;
    updateCodeGeneratorWithDynamicRelays(device.id);
    
    setTimeout(() => {
        generateDynamicCode();
        showNotification(`<i class="fas fa-download"></i> Đang tạo code cho thiết bị ${device.id}`, 'info');
    }, 1000);
}

function updateGenerateOptions() {
    const generateOptions = document.querySelector('.generate-options');
    if (generateOptions) {
        generateOptions.innerHTML = `
            <button onclick="generateDynamicCode()" class="generate-btn primary">
                <i class="fas fa-sync"></i> TẠO CODE ĐỘNG
            </button>
            <button onclick="showCodeHelp()" class="generate-btn info">
                <i class="fas fa-question-circle"></i> HƯỚNG DẪN
            </button>
        `;
    }
}

function showCodeHelp() {
    document.getElementById('codeHelpContent').innerHTML = `
        <div class="code-help-content">
            <div class="help-section">
                <h4><i class="fas fa-download"></i> Các bước sử dụng:</h4>
                <div class="steps">
                    <div class="step">
                        <span class="step-number">1</span>
                        <div class="step-content">
                            <strong>Tạo code động</strong>
                            <p>Nhấn nút "TẠO CODE ĐỘNG" để tạo code phù hợp với cấu hình của bạn</p>
                        </div>
                    </div>
                    <div class="step">
                        <span class="step-number">2</span>
                        <div class="step-content">
                            <strong>Cài đặt Arduino IDE</strong>
                            <p>Tải và cài đặt Arduino IDE từ <a href="https://www.arduino.cc/en/software" target="_blank">arduino.cc</a></p>
                        </div>
                    </div>
                    <div class="step">
                        <span class="step-number">3</span>
                        <div class="step-content">
                            <strong>Cài đặt thư viện</strong>
                                <ul>
                                <li><strong>PubSubClient</strong> - Quản lý MQTT</li>
                                <li><strong>ArduinoJson</strong> - Xử lý JSON</li>
                                <li><strong>WiFi</strong> (có sẵn cho ESP32)</li>
                            </ul>
                        </div>
                    </div>
                    <div class="step">
                        <span class="step-number">4</span>
                        <div class="step-content">
                            <strong>Cấu hình Board ESP32</strong>
                            <p>Trong Arduino IDE: Tools → Board → ESP32 Arduino → "ESP32 Dev Module"</p>
                        </div>
                    </div>
                    <div class="step">
                        <span class="step-number">5</span>
                        <div class="step-content">
                            <strong>Nạp code và sử dụng</strong>
                            <p>Kết nối ESP32 via USB, chọn đúng Port và nạp code</p>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="help-section">
                <h4><i class="fas fa-cog"></i> Tính năng Code Động:</h4>
                <div class="feature-list">
                    <div class="feature-item">
                        <i class="fas fa-check-circle"></i>
                        <span><strong>Cấu hình chân GPIO động</strong> - Không cần nạp lại code khi thay đổi chân</span>
                    </div>
                    <div class="feature-item">
                        <i class="fas fa-check-circle"></i>
                        <span><strong>Tự động nhận cấu hình</strong> - ESP32 tự động lấy cấu hình từ server</span>
                    </div>
                    <div class="feature-item">
                        <i class="fas fa-check-circle"></i>
                        <span><strong>Bảo mật API Key</strong> - Mỗi thiết bị có key riêng để xác thực</span>
                    </div>
                    <div class="feature-item">
                        <i class="fas fa-check-circle"></i>
                        <span><strong>Hỗ trợ đa relay linh hoạt</strong> - Từ 1 đến ${MAX_RELAYS_PER_DEVICE} relay tuỳ ý</span>
                    </div>
                    <div class="feature-item">
                        <i class="fas fa-check-circle"></i>
                        <span><strong>Tự động đồng bộ cấu hình</strong> - Thay đổi từ web tự động gửi đến ESP32</span>
                    </div>
                </div>
            </div>
            
            <div class="help-section">
                <h4><i class="fas fa-wrench"></i> Khắc phục sự cố:</h4>
                <div class="troubleshooting">
                    <div class="issue">
                        <strong>Lỗi biên dịch:</strong>
                        <p>Kiểm tra đã cài đầy đủ thư viện và chọn đúng board ESP32</p>
                    </div>
                    <div class="issue">
                        <strong>Không kết nối WiFi:</strong>
                        <p>Kiểm tra SSID và password và tín hiệu WiFi</p>
                    </div>
                    <div class="issue">
                        <strong>Không kết nối MQTT:</strong>
                        <p>Kiểm tra MQTT broker, port và API Key</p>
                    </div>
                    <div class="issue">
                        <strong>Relay không hoạt động:</strong>
                        <p>Kiểm tra kết nối dây, nguồn và cấu hình chân GPIO</p>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="form-actions" style="margin-top: 20px; text-align: center;">
            <button onclick="generateDynamicCode()" class="btn-success">
                <i class="fas fa-download"></i> TẠO CODE ĐỘNG NGAY
            </button>
            <button onclick="closeCodeHelp()" class="btn-secondary">
                <i class="fas fa-times"></i> Đóng
            </button>
        </div>
    `;
    
    document.getElementById('codeHelpModal').style.display = 'block';
}

function closeCodeHelp() {
    document.getElementById('codeHelpModal').style.display = 'none';
}

// ==================== AUTO SYNC CONFIGURATION FUNCTIONS ====================
async function autoSyncConfiguration(espId, operation = 'update') {
    try {
        // Gửi yêu cầu cấu hình đến ESP32
        const res = await fetch(`/api/esp/${espId}/config/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                operation: operation,
                timestamp: Date.now()
            })
        });
        
        if (res.ok) {
            const data = await res.json();
            if (data.ok && data.synced) {
                console.log(`✅ Configuration auto-synced to ${espId} (${operation})`);
                
                // Gửi MQTT command để ESP32 lấy cấu hình mới
                sendCommand(espId, { command: 'GET_CONFIG' });
                
                // Hiển thị thông báo nhẹ nhàng
                if (operation === 'add') {
                    showNotification(`<i class="fas fa-sync-alt"></i> Đã tự động đồng bộ cấu hình mới đến ${espId}`, 'info', 2000);
                } else if (operation === 'update') {
                    showNotification(`<i class="fas fa-sync-alt"></i> Đã tự động cập nhật cấu hình đến ${espId}`, 'info', 2000);
                } else if (operation === 'delete') {
                    showNotification(`<i class="fas fa-sync-alt"></i> Đã tự động cập nhật cấu hình (đã xóa relay) đến ${espId}`, 'info', 2000);
                }
                
                return true;
            }
        }
        return false;
    } catch (error) {
        console.error(`❌ Error auto-syncing configuration to ${espId}:`, error);
        return false;
    }
}

// ==================== MQTT HEALTH CHECK ====================
async function checkMqttHealth() {
    try {
        showNotification('<i class="fas fa-sync-alt fa-spin"></i> Đang kiểm tra kết nối MQTT...', 'info');
        
        const res = await fetch('/api/mqtt/health');
        const data = await res.json();
        
        if (res.ok) {
            const status = data.mqtt.connected ? 
                '<i class="fas fa-check-circle"></i> Đã kết nối MQTT Broker' : 
                '<i class="fas fa-times-circle"></i> Mất kết nối MQTT';
            
            showNotification(`${status} - Broker: ${data.mqtt.broker}:${data.mqtt.port}`, 
                data.mqtt.connected ? 'success' : 'error');
        } else {
            showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi kiểm tra MQTT health', 'error');
        }
    } catch (error) {
        console.error('MQTT Health Check Error:', error);
        showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi kết nối khi kiểm tra MQTT', 'error');
    }
}

async function testMqttConnection() {
    try {
        showNotification('<i class="fas fa-sync-alt fa-spin"></i> Đang kiểm tra kết nối MQTT real-time...', 'info');
        
        const res = await fetch('/api/mqtt/test-connection');
        const data = await res.json();
        
        if (res.ok && data.ok) {
            showNotification(`✅ ${data.message} - Broker: ${data.details.broker}:${data.details.port}`, 'success');
        } else {
            showNotification(`❌ ${data.message || 'Lỗi kiểm tra kết nối MQTT'}`, 'error');
        }
    } catch (error) {
        console.error('MQTT Connection Test Error:', error);
        showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi kết nối server', 'error');
    }
}

// ==================== MODAL FUNCTIONS ====================
function showAddDeviceModal() {
    document.getElementById('addDeviceModal').style.display = 'block';
    document.getElementById('newEspId').value = '';
    document.getElementById('newEspLabel').value = '';
    document.getElementById('newEspMaxRelays').value = '50';
    document.getElementById('newEspId').focus();
}

function closeAddDeviceModal() {
    document.getElementById('addDeviceModal').style.display = 'none';
    document.getElementById('newEspId').value = '';
    document.getElementById('newEspLabel').value = '';
    document.getElementById('newEspMaxRelays').value = '50';
}

function showAddRelayModal(espId) {
    currentAddingRelayDeviceId = espId;
    currentAddMode = 'single';
    document.getElementById('addRelayModal').style.display = 'block';
    
    document.getElementById('newRelayNumber').value = '';
    document.getElementById('newRelayName').value = '';
    document.getElementById('newRelayPin').value = '';
    document.getElementById('newRelayType').value = 'LOW';
    document.getElementById('newRelayIcon').value = 'fa-sliders-h';
    
    document.getElementById('multipleRelayCount').value = '5';
    document.getElementById('multipleRelayType').value = 'LOW';
    document.getElementById('multipleRelayIcon').value = 'fa-sliders-h';
    document.getElementById('multipleRelayPrefix').value = 'Relay';
    
    document.getElementById('modeSingle').checked = true;
    changeAddMode('single');
    document.getElementById('addRelayPinSuggestionsSection').style.display = 'none';
    
    suggestNextRelayNumber(espId);
    document.getElementById('newRelayName').focus();
}

function closeAddRelayModal() {
    document.getElementById('addRelayModal').style.display = 'none';
    currentAddingRelayDeviceId = '';
}

function showEditRelayModal(espId, relayNumber, currentName, currentPin, currentType = 'LOW', currentIcon = 'fa-sliders-h') {
    currentEditingRelay = { espId, relayNumber };
    document.getElementById('editRelayNumberDisplay').textContent = relayNumber;
    document.getElementById('editRelayName').value = currentName;
    document.getElementById('editRelayPin').value = currentPin;
    document.getElementById('editRelayType').value = currentType;
    document.getElementById('editRelayIcon').value = currentIcon;
    
    document.getElementById('editRelayPinSuggestionsSection').style.display = 'none';
    document.getElementById('editRelayModal').style.display = 'block';
    document.getElementById('editRelayName').focus();
}

function closeEditRelayModal() {
    document.getElementById('editRelayModal').style.display = 'none';
    currentEditingRelay = null;
}

function saveRelayChanges() {
    if (!currentEditingRelay) return;

    const newName = document.getElementById('editRelayName').value.trim();
    const newPin = parseInt(document.getElementById('editRelayPin').value);
    const newType = document.getElementById('editRelayType').value;
    const newIcon = document.getElementById('editRelayIcon').value;

    if (!newName) {
        showNotification('<i class="fas fa-exclamation-circle"></i> Vui lòng nhập tên relay', 'error');
        return;
    }

    if (isNaN(newPin) || newPin < 0 || newPin > 39) {
        showNotification('<i class="fas fa-exclamation-circle"></i> GPIO pin phải từ 0 đến 39', 'error');
        return;
    }

    updateRelayInDatabase(currentEditingRelay.espId, currentEditingRelay.relayNumber, newName, newPin, newType, newIcon);
}

async function updateRelayInDatabase(espId, relayNumber, name, gpio_pin, relay_type, icon) {
    try {
        const res = await fetch(`/api/esp/${espId}/relays/${relayNumber}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: name,
                gpio_pin: gpio_pin,
                relay_type: relay_type,
                icon: icon
            })
        });

        const data = await res.json();

        if (res.ok) {
            showNotification('<i class="fas fa-check-circle"></i> Đã cập nhật thông tin relay', 'success');
            closeEditRelayModal();
            await loadRelaysForDevice(espId);
            
            // Tự động đồng bộ cấu hình đến ESP32
            await autoSyncConfiguration(espId, 'update');
        } else {
            showNotification(`<i class="fas fa-exclamation-circle"></i> Lỗi: ${data.error}`, 'error');
        }
    } catch (error) {
        console.error('Error updating relay:', error);
        showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi kết nối server', 'error');
    }
}

async function deleteRelay(espId, relayNumber) {
    if (!confirm(`⚠️ XÓA RELAY\n\nBạn có chắc chắn muốn xóa relay ${relayNumber}?\n\nThao tác này sẽ xóa vĩnh viễn relay khỏi hệ thống.`)) {
        return;
    }

    try {
        const res = await fetch(`/api/esp/${espId}/relays/${relayNumber}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await res.json();

        if (res.ok) {
            showNotification(`<i class="fas fa-check-circle"></i> Đã xóa relay ${relayNumber}`, 'success');
            await loadRelaysForDevice(espId);
            
            // Tự động đồng bộ cấu hình đến ESP32
            await autoSyncConfiguration(espId, 'delete');
        } else {
            showNotification(`<i class="fas fa-exclamation-circle"></i> Lỗi: ${data.error}`, 'error');
        }
    } catch (error) {
        console.error('Error deleting relay:', error);
        showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi kết nối server', 'error');
    }
}

async function suggestNextRelayNumber(espId) {
    try {
        const res = await fetch(`/api/esp/${espId}/relays/config`);
        if (res.ok) {
            const data = await res.json();
            if (data.ok) {
                const relays = data.relays;
                const usedNumbers = relays.map(r => r.relay_number);
                let nextNumber = 1;
                
                while (usedNumbers.includes(nextNumber) && nextNumber <= MAX_RELAYS_PER_DEVICE) {
                    nextNumber++;
                }
                
                if (nextNumber > MAX_RELAYS_PER_DEVICE) {
                    showNotification(`<i class="fas fa-exclamation-circle"></i> Đã đạt tối đa ${MAX_RELAYS_PER_DEVICE} relay`, 'warning');
                    document.getElementById('newRelayNumber').value = MAX_RELAYS_PER_DEVICE;
                } else {
                    document.getElementById('newRelayNumber').value = nextNumber;
                }
            }
        }
    } catch (error) {
        console.error('Error suggesting relay number:', error);
        document.getElementById('newRelayNumber').value = 1;
    }
}

async function addNewRelayOrMultiple() {
    if (currentAddMode === 'single') {
        await addSingleRelay();
    } else {
        await addMultipleRelays();
    }
}

async function addSingleRelay() {
    const relayNumber = parseInt(document.getElementById('newRelayNumber').value);
    const relayName = document.getElementById('newRelayName').value.trim();
    const relayPin = parseInt(document.getElementById('newRelayPin').value);
    const relayType = document.getElementById('newRelayType').value;
    const relayIcon = document.getElementById('newRelayIcon').value;

    if (!relayNumber || isNaN(relayNumber) || relayNumber < 1 || relayNumber > MAX_RELAYS_PER_DEVICE) {
        showNotification(`<i class="fas fa-exclamation-circle"></i> Số relay phải từ 1 đến ${MAX_RELAYS_PER_DEVICE}`, 'error');
        return;
    }

    if (!relayName) {
        showNotification('<i class="fas fa-exclamation-circle"></i> Vui lòng nhập tên relay', 'error');
        return;
    }

    if (isNaN(relayPin) || relayPin < 0 || relayPin > 39) {
        showNotification('<i class="fas fa-exclamation-circle"></i> GPIO pin phải từ 0 đến 39', 'error');
        return;
    }

    try {
        const res = await fetch(`/api/esp/${currentAddingRelayDeviceId}/relays`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                relay_number: relayNumber,
                name: relayName,
                gpio_pin: relayPin,
                relay_type: relayType,
                icon: relayIcon
            })
        });

        const data = await res.json();

        if (res.ok) {
            showNotification(`<i class="fas fa-check-circle"></i> Đã thêm relay "${relayName}" (GPIO ${relayPin})`, 'success');
            closeAddRelayModal();
            await loadRelaysForDevice(currentAddingRelayDeviceId);
            
            // Tự động đồng bộ cấu hình đến ESP32
            await autoSyncConfiguration(currentAddingRelayDeviceId, 'add');
        } else {
            showNotification(`<i class="fas fa-exclamation-circle"></i> Lỗi: ${data.error}`, 'error');
        }
    } catch (error) {
        console.error('Error adding relay:', error);
        showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi kết nối server', 'error');
    }
}

async function addMultipleRelays() {
    const count = parseInt(document.getElementById('multipleRelayCount').value);
    const relayType = document.getElementById('multipleRelayType').value;
    const icon = document.getElementById('multipleRelayIcon').value;
    const prefix = document.getElementById('multipleRelayPrefix').value || 'Relay';
    
    if (!count || count < 2 || count > MAX_RELAYS_PER_DEVICE) {
        showNotification(`<i class="fas fa-exclamation-circle"></i> Số lượng relay phải từ 2 đến ${MAX_RELAYS_PER_DEVICE}`, 'error');
        return;
    }
    
    try {
        showNotification(`<i class="fas fa-sync-alt fa-spin"></i> Đang thêm ${count} relay...`, 'info');
        
        const res = await fetch(`/api/esp/${currentAddingRelayDeviceId}/relays/config`);
        const data = await res.json();
        
        if (!data.ok) throw new Error('Không thể lấy thông tin relay');
        
        const currentRelays = data.relays || [];
        const usedNumbers = currentRelays.map(r => r.relay_number);
        const usedPins = currentRelays.map(r => r.gpio_pin);
        
        const safePins = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33];
        const availablePins = safePins.filter(pin => !usedPins.includes(pin));
        
        if (availablePins.length < count) {
            showNotification(`<i class="fas fa-exclamation-circle"></i> Chỉ có ${availablePins.length} GPIO pin khả dụng, không đủ để thêm ${count} relay`, 'error');
            return;
        }
        
        let addedCount = 0;
        let failedCount = 0;
        const errors = [];
        
        for (let i = 1; i <= count && i <= availablePins.length; i++) {
            let relayNumber = 1;
            while (usedNumbers.includes(relayNumber) && relayNumber <= MAX_RELAYS_PER_DEVICE) {
                relayNumber++;
            }
            
            if (relayNumber > MAX_RELAYS_PER_DEVICE) {
                showNotification(`<i class="fas fa-exclamation-circle"></i> Đã đạt tối đa ${MAX_RELAYS_PER_DEVICE} relay, chỉ thêm được ${addedCount} relay`, 'warning');
                break;
            }
            
            const relayName = `${prefix} ${relayNumber}`;
            const gpioPin = availablePins[i - 1];
            
            try {
                const addRes = await fetch(`/api/esp/${currentAddingRelayDeviceId}/relays`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        relay_number: relayNumber,
                        name: relayName,
                        gpio_pin: gpioPin,
                        relay_type: relayType,
                        icon: icon
                    })
                });
                
                const addData = await addRes.json();
                
                if (addRes.ok) {
                    usedNumbers.push(relayNumber);
                    usedPins.push(gpioPin);
                    addedCount++;
                } else {
                    failedCount++;
                    errors.push(`Relay ${relayNumber}: ${addData.error || 'Lỗi không xác định'}`);
                }
            } catch (error) {
                failedCount++;
                errors.push(`Relay ${relayNumber}: Lỗi kết nối`);
            }
        }
        
        if (addedCount > 0) {
            showNotification(`<i class="fas fa-check-circle"></i> Đã thêm ${addedCount}/${count} relay thành công!`, 'success');
            closeAddRelayModal();
            await loadRelaysForDevice(currentAddingRelayDeviceId);
            
            // Tự động đồng bộ cấu hình đến ESP32
            await autoSyncConfiguration(currentAddingRelayDeviceId, 'add');
        }
        
        if (failedCount > 0) {
            setTimeout(() => {
                showNotification(`<i class="fas fa-exclamation-triangle"></i> ${failedCount} relay thất bại. Xem console để biết chi tiết`, 'warning');
                console.error('Lỗi thêm relay:', errors);
            }, 1000);
        }
        
    } catch (error) {
        console.error('Error adding multiple relays:', error);
        showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi khi thêm nhiều relay', 'error');
    }
}

// ==================== API KEY MANAGEMENT ====================
async function getUserApiKey() {
    const button = document.getElementById('getApiKeyBtn');
    const originalText = button.innerHTML;
    
    try {
        showButtonLoading(button, true);
        showNotification('<i class="fas fa-sync-alt fa-spin"></i> Đang lấy API Key...', 'info');
        
        const res = await fetch('/api/user/apikey');
        const data = await res.json();
        
        if (res.ok) {
            userApiKey = data.apiKey;
            document.getElementById('apiKey').value = userApiKey;
            document.getElementById('apiKey').classList.add('api-key-valid');
            showNotification('<i class="fas fa-check-circle"></i> Đã lấy API Key thành công', 'success');
            console.log('API Key loaded:', userApiKey);
        } else {
            showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi khi lấy API Key: ' + (data.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        console.error('Get API Key error:', error);
        showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi kết nối server khi lấy API Key', 'error');
    } finally {
        showButtonLoading(button, false, originalText);
    }
}

async function showApiKeyModal() {
    try {
        showNotification('<i class="fas fa-sync-alt fa-spin"></i> Đang tải thông tin API Key...', 'info');
        
        const res = await fetch('/api/user/apikey');
        const data = await res.json();
        
        if (res.ok) {
            userApiKey = data.apiKey;
            document.getElementById('displayApiKey').textContent = userApiKey;
            document.getElementById('apiKeyModal').style.display = 'block';
            showNotification('<i class="fas fa-check-circle"></i> Đã tải API Key thành công', 'success');
        } else {
            showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi khi lấy thông tin API Key', 'error');
        }
    } catch (error) {
        console.error('Show API Key modal error:', error);
        showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi kết nối server', 'error');
    }
}

function closeApiKeyModal() {
    document.getElementById('apiKeyModal').style.display = 'none';
}

async function generateNewApiKey() {
    if (!confirm('⚠️ TẠO KEY MỚI\n\nTạo key mới sẽ làm mất hiệu lực key cũ. Tất cả thiết bị đang dùng key cũ sẽ ngừng hoạt động cho đến khi được cập nhật key mới.\n\nBạn có chắc chắn muốn tạo key mới?')) {
        return;
    }

    try {
        showNotification('<i class="fas fa-sync-alt fa-spin"></i> Đang tạo API Key mới...', 'info');
        
        const res = await fetch('/api/user/apikey/new', { 
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const data = await res.json();
        
        if (res.ok) {
            userApiKey = data.apiKey;
            document.getElementById('displayApiKey').textContent = userApiKey;
            document.getElementById('apiKey').value = userApiKey;
            showNotification('<i class="fas fa-check-circle"></i> Đã tạo API Key mới thành công', 'success');
            console.log('New API Key:', userApiKey);
        } else {
            showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi khi tạo API Key mới: ' + (data.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        console.error('Generate new API Key error:', error);
        showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi kết nối server khi tạo API Key mới', 'error');
    }
}

function copyApiKey() {
    const apiKey = document.getElementById('displayApiKey').textContent;
    if (!apiKey || apiKey === 'Đang tải...') {
        showNotification('<i class="fas fa-exclamation-circle"></i> Chưa có API Key để copy', 'error');
        return;
    }
    
    navigator.clipboard.writeText(apiKey).then(() => {
        showNotification('<i class="fas fa-check-circle"></i> Đã copy API Key vào clipboard', 'success');
    }).catch(err => {
        showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi khi copy API Key', 'error');
    });
}

// ==================== SYSTEM STATUS ====================
async function showSystemStatus() {
    try {
        document.getElementById('systemStatusModal').style.display = 'block';
        const content = document.getElementById('systemStatusContent');
        content.innerHTML = '<div class="loading"><i class="fas fa-sync-alt fa-spin"></i> Đang tải thông tin hệ thống...</div>';
        
        const [systemRes, mqttRes] = await Promise.all([
            fetch('/api/system/status'),
            fetch('/api/mqtt/health')
        ]);
        
        const systemData = await systemRes.json();
        const mqttData = await mqttRes.json();
        
        if (systemRes.ok && mqttRes.ok) {
            content.innerHTML = `
                <div class="system-status">
                    <div class="status-section">
                        <h4><i class="fas fa-user"></i> Thông tin User</h4>
                        <div class="status-grid">
                            <div class="status-item">
                                <span class="label">Tên user:</span>
                                <span class="value">${systemData.user.username}</span>
                            </div>
                            <div class="status-item">
                                <span class="label">Số thiết bị:</span>
                                <span class="value">${systemData.user.deviceCount}</span>
                            </div>
                            <div class="status-item">
                                <span class="label">Số session:</span>
                                <span class="value">${systemData.user.sessionCount}</span>
                            </div>
                        </div>
                    </div>
                    
                    <div class="status-section">
                        <h4><i class="fas fa-server"></i> Hệ thống</h4>
                        <div class="status-grid">
                            <div class="status-item">
                                <span class="label">Tổng users:</span>
                                <span class="value">${systemData.system.totalUsers}</span>
                            </div>
                            <div class="status-item">
                                <span class="label">Tổng thiết bị:</span>
                                <span class="value">${systemData.system.totalDevices}</span>
                            </div>
                            <div class="status-item">
                                <span class="label">Tổng relay:</span>
                                <span class="value">${systemData.system.totalRelays}</span>
                            </div>
                            <div class="status-item">
                                <span class="label">Node.js Version:</span>
                                <span class="value">${mqttData.system?.nodeVersion || 'N/A'}</span>
                            </div>
                        </div>
                    </div>
                    
                    <div class="status-section">
                        <h4><i class="fas fa-network-wired"></i> MQTT Connection</h4>
                        <div class="status-grid">
                            <div class="status-item">
                                <span class="label">Trạng thái:</span>
                                <span class="value ${mqttData.mqtt.connected ? 'online' : 'offline'}">
                                    ${mqttData.mqtt.connected ? 
                                        '<i class="fas fa-check-circle"></i> Connected' : 
                                        '<i class="fas fa-times-circle"></i> Disconnected'}
                                </span>
                            </div>
                            <div class="status-item">
                                <span class="label">Broker:</span>
                                <span class="value">${mqttData.mqtt.broker}:${mqttData.mqtt.port}</span>
                            </div>
                            <div class="status-item">
                                <span class="label">Client ID:</span>
                                <span class="value">${mqttData.mqtt.clientId}</span>
                            </div>
                            <div class="status-item">
                                <span class="label">Reconnecting:</span>
                                <span class="value">${mqttData.mqtt.reconnecting ? 'Yes' : 'No'}</span>
                            </div>
                            <div class="status-item">
                                <span class="label">Pending:</span>
                                <span class="value">${mqttData.mqtt.pending} messages</span>
                            </div>
                            <div class="status-item">
                                <span class="label">Last Activity:</span>
                                <span class="value">${new Date(mqttData.mqtt.timestamp).toLocaleString('vi-VN')}</span>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="form-actions" style="margin-top: 20px;">
                    <button onclick="testMqttConnection()" class="btn-success">
                        <i class="fas fa-bolt"></i> Test MQTT Connection
                    </button>
                    <button onclick="closeSystemStatus()" class="btn-secondary">
                        <i class="fas fa-times"></i> Đóng
                    </button>
                </div>
            `;
        } else {
            content.innerHTML = '<div class="error"><i class="fas fa-exclamation-circle"></i> Lỗi khi lấy thông tin hệ thống</div>';
        }
    } catch (error) {
        console.error('System status error:', error);
        document.getElementById('systemStatusContent').innerHTML = '<div class="error"><i class="fas fa-exclamation-circle"></i> Lỗi kết nối server</div>';
    }
}

function closeSystemStatus() {
    document.getElementById('systemStatusModal').style.display = 'none';
}

// ==================== AUTHENTICATION ====================
function showTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.style.display = 'none';
    });
    
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    document.getElementById(tabName + 'Tab').style.display = 'block';
    event.currentTarget.classList.add('active');
    
    if (tabName === 'codegen') {
        setTimeout(updateGenerateOptions, 100);
    }
    
    if (window.innerWidth <= 768) {
        window.scrollTo(0, 0);
    }
}

async function checkAuth() {
    try {
        const res = await fetch('/api/me');
        if (res.ok) {
            const data = await res.json();
            showDashboard(data);
        } else {
            showLogin();
        }
    } catch (error) {
        showLogin();
        showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi kết nối đến server', 'error');
    }
}

function showLogin() {
    document.getElementById('loginPage').style.display = 'block';
    document.getElementById('dashboardPage').style.display = 'none';
}

async function showDashboard(data) {
    document.getElementById('loginPage').style.display = 'none';
    document.getElementById('dashboardPage').style.display = 'block';
    document.getElementById('userName').textContent = data.username;
    document.getElementById('deviceCount').textContent = data.deviceCount + ' thiết bị';
    userApiKey = data.apiKey;
    await renderDevices(data.esps || []);
}

async function login() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const button = event.target;

    if (!username || !password) {
        showMessage('Vui lòng nhập đầy đủ thông tin', 'error');
        return;
    }

    try {
        showButtonLoading(button, true);
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const result = await res.json();
        handleAuthResponse(result);
    } catch (error) {
        showMessage('Lỗi kết nối đến server', 'error');
    } finally {
        showButtonLoading(button, false);
    }
}

async function register() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const button = event.target;

    if (!username || !password) {
        showMessage('Vui lòng nhập đầy đủ thông tin', 'error');
        return;
    }

    if (password.length < 6) {
        showMessage('Mật khẩu phải có ít nhất 6 ký tự', 'error');
        return;
    }

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        showMessage('Tên đăng nhập chỉ được chứa chữ cái, số và gạch dưới (3-20 ký tự)', 'error');
        return;
    }

    try {
        showButtonLoading(button, true);
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const result = await res.json();
        handleAuthResponse(result);
    } catch (error) {
        showMessage('Lỗi kết nối đến server', 'error');
    } finally {
        showButtonLoading(button, false);
    }
}

function handleAuthResponse(response) {
    if (response.ok) {
        showMessage(response.message || 'Thành công!', 'success');
        setTimeout(() => location.reload(), 1500);
    } else {
        showMessage(response.error, 'error');
    }
}

function showButtonLoading(button, isLoading, originalText = null) {
    const btnText = button.querySelector('.btn-text');
    const spinner = button.querySelector('.spinner');
    
    if (isLoading) {
        button.disabled = true;
        if (btnText) btnText.style.display = 'none';
        if (spinner) spinner.style.display = 'inline-block';
    } else {
        button.disabled = false;
        if (btnText) btnText.style.display = 'inline';
        if (spinner) spinner.style.display = 'none';
        if (originalText) button.innerHTML = originalText;
    }
}

function showMessage(msg, type) {
    const el = document.getElementById('message');
    el.textContent = msg;
    el.className = `message ${type}`;
}

async function logout() {
    try {
        await fetch('/api/logout');
        showNotification('<i class="fas fa-info-circle"></i> Đã đăng xuất', 'info');
        setTimeout(() => location.reload(), 1000);
    } catch (error) {
        showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi khi đăng xuất', 'error');
    }
}

// ==================== DEVICE MANAGEMENT ====================
function findDeviceItem(espId) {
    const deviceItems = document.querySelectorAll('.device-item');
    for (const item of deviceItems) {
        const deviceIdElement = item.querySelector('.device-id');
        if (deviceIdElement && deviceIdElement.textContent.includes(espId)) {
            return item;
        }
    }
    return null;
}

async function renderDevices(devices) {
    const list = document.getElementById('deviceList');
    userDevices = devices;
    
    if (devices.length === 0) {
        list.innerHTML = `
            <div class="empty">
                <div class="empty-icon"><i class="fas fa-microchip"></i></div>
                <p>Chưa có thiết bị nào</p>
                <small>Hãy thêm thiết bị đầu tiên của bạn!</small>
            </div>
        `;
        return;
    }
    
    list.innerHTML = '';
    
    const devicePromises = devices.map(async (device) => {
        const lastSeen = device.lastSeen ? formatTimeAgo(new Date(device.lastSeen).getTime()) : 'Chưa kết nối';
        const status = device.status === 'online' ? '<i class="fas fa-circle"></i> Online' : '<i class="fas fa-circle"></i> Offline';
        
        const div = document.createElement('div');
        div.className = `device-item ${device.status === 'online' ? 'online' : 'offline'}`;
        div.setAttribute('data-esp-id', device.id);
        
        div.innerHTML = `
            <div class="device-header">
                <div class="device-info">
                    <div class="device-title-row">
                        <div class="device-id">
                            <i class="fas fa-microchip device-id-icon"></i>
                            ${device.id}
                        </div>
                        <span class="device-status ${device.status}">${status}</span>
                    </div>
                    ${device.label && device.label !== device.id ? `<div class="device-label">${device.label}</div>` : ''}
                    <div class="device-meta">
                        <small><i class="fas fa-calendar-plus"></i> Thêm: ${new Date(device.createdAt).toLocaleDateString('vi-VN')}</small>
                        <small><i class="fas fa-clock"></i> Lần cuối: ${lastSeen}</small>
                    </div>
                </div>
                <div class="device-controls">
                    <button class="btn-control btn-download-code" onclick="downloadCodeForDevice('${device.id}')" title="Tải Code cho thiết bị này">
                        <i class="fas fa-download"></i>
                    </button>
                    <button class="btn-control btn-toggle-all" onclick="toggleAllRelaysOfDevice('${device.id}')" title="Bật/tắt tất cả relay">
                        <i class="fas fa-power-off"></i>
                    </button>
                    <button class="btn-control btn-add-relay" onclick="showAddRelayModal('${device.id}')" title="Thêm relay mới">
                        <i class="fas fa-plus-circle"></i>
                    </button>
                    <button class="btn-control btn-delete" onclick="deleteDevice('${device.id}')" title="Xóa thiết bị">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
            
            <div class="relay-management-section" id="relayManagement-${device.id}">
                <!-- Sẽ được điền bởi loadRelaysForDevice -->
            </div>
            
            <div class="device-relay-controls">
                <div class="relay-grid" id="relayGrid-${device.id}">
                    <!-- Relay buttons sẽ được tạo ở đây -->
                </div>
            </div>
        `;
        list.appendChild(div);
        
        await loadRelaysForDevice(device.id);
        await loadToggleAllState(device.id);
    });
    
    await Promise.all(devicePromises);
}

async function loadRelaysForDevice(espId) {
    try {
        const res = await fetch(`/api/esp/${espId}/relays/config`);
        if (res.ok) {
            const data = await res.json();
            if (data.ok) {
                deviceRelays.set(espId, data.relays);
                renderRelays(espId, data.relays);
                updateRelayManagementUI(espId);
                await loadRelayStates(espId);
            }
        }
    } catch (error) {
        console.error(`❌ Error loading relays for ${espId}:`, error);
    }
}

function renderRelays(espId, relays) {
    const relayGrid = document.getElementById(`relayGrid-${espId}`);
    if (!relayGrid) return;
    
    relays.sort((a, b) => a.relay_number - b.relay_number);
    
    let relayHTML = '';
    relays.forEach(relay => {
        const isActive = relay.last_state === 1;
        relayHTML += `
            <div class="relay-item ${isActive ? 'on' : 'off'}" onclick="toggleRelay('${espId}', ${relay.relay_number})" id="relayItem-${espId}-${relay.relay_number}">
                <div class="relay-header">
                    <i class="fas ${relay.icon} relay-icon"></i>
                    <span class="relay-label">${relay.name}</span>
                    <small class="relay-info">GPIO ${relay.gpio_pin}</small>
                </div>
                <div class="relay-actions">
                    <button class="relay-action-btn edit-btn" onclick="event.stopPropagation(); showEditRelayModal('${espId}', ${relay.relay_number}, '${relay.name.replace(/'/g, "\\'")}', ${relay.gpio_pin}, '${relay.relay_type}', '${relay.icon}')" title="Sửa relay & GPIO">
                        <i class="fas fa-cog"></i>
                    </button>
                    <button class="relay-action-btn delete-btn" onclick="event.stopPropagation(); deleteRelay('${espId}', ${relay.relay_number})" title="Xóa relay">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `;
    });
    
    relayGrid.innerHTML = relayHTML;
    updateRelayCountInfo(espId, relays.length);
}

function updateRelayCountInfo(espId, currentCount) {
    const deviceItem = findDeviceItem(espId);
    if (!deviceItem) return;
    
    const countElement = deviceItem.querySelector('.relay-count-info');
    
    if (!countElement) {
        const newCountElement = document.createElement('div');
        newCountElement.className = 'relay-count-info';
        newCountElement.innerHTML = `<small><i class="fas fa-sliders-h"></i> ${currentCount}/${MAX_RELAYS_PER_DEVICE} relay</small>`;
        deviceItem.querySelector('.device-meta').appendChild(newCountElement);
    } else {
        countElement.innerHTML = `<small><i class="fas fa-sliders-h"></i> ${currentCount}/${MAX_RELAYS_PER_DEVICE} relay</small>`;
    }
}

function updateRelayManagementUI(espId) {
    const managementSection = document.getElementById(`relayManagement-${espId}`);
    
    if (managementSection) {
        managementSection.innerHTML = `
           
        `;
    }
}

// ==================== RELAY CONTROL ====================
function toggleRelay(espId, relayNumber) {
    const relayItem = document.getElementById(`relayItem-${espId}-${relayNumber}`);
    
    if (relayItem.classList.contains('loading')) {
        return;
    }
    
    relayItem.classList.add('loading');
    
    const isCurrentlyOn = relayItem.classList.contains('on');
    const newState = isCurrentlyOn ? 0 : 1;
    
    updateRelayUI(espId, relayNumber, newState);
    sendRelayCommand(espId, relayNumber, newState);
    saveRelayState(espId, relayNumber, newState);
    
    setTimeout(() => {
        relayItem.classList.remove('loading');
    }, 1000);
}

function updateRelayUI(espId, relayNumber, status) {
    const relayItem = document.getElementById(`relayItem-${espId}-${relayNumber}`);
    if (!relayItem) return;
    
    if (status === 1) {
        relayItem.classList.remove('off');
        relayItem.classList.add('on');
        showRelayFeedback(relayItem, 'success');
    } else {
        relayItem.classList.remove('on');
        relayItem.classList.add('off');
        showRelayFeedback(relayItem, 'off');
    }
}

function showRelayFeedback(relayItem, type) {
    relayItem.classList.add('feedback');
    
    if (type === 'success') {
        relayItem.style.transform = 'scale(0.95)';
        setTimeout(() => {
            relayItem.style.transform = '';
        }, 150);
    }
    
    setTimeout(() => {
        relayItem.classList.remove('feedback');
    }, 300);
}

function sendRelayCommand(espId, relayNumber, value) {
    sendCommand(espId, { relay: relayNumber, value: value });
}

async function deleteDevice(espId) {
    if (!confirm(`⚠️ XÓA THIẾT BỊ\n\nBạn có chắc chắn muốn xóa thiết bị "${espId}"?\n\nThao tác này không thể hoàn tác!`)) {
        return;
    }

    try {
        showNotification(`<i class="fas fa-trash fa-spin"></i> Đang xóa thiết bị ${espId}...`, 'info');
        
        const res = await fetch(`/api/esp/${espId}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const data = await res.json();
        
        if (res.ok) {
            showNotification(`<i class="fas fa-check-circle"></i> Đã xóa thiết bị ${espId} thành công`, 'success');
            
            setTimeout(() => {
                location.reload();
            }, 1000);
            
        } else {
            showNotification(`<i class="fas fa-exclamation-circle"></i> Lỗi khi xóa thiết bị: ${data.error}`, 'error');
        }
    } catch (error) {
        console.error('Delete device error:', error);
        showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi kết nối khi xóa thiết bị', 'error');
    }
}

async function addDevice() {
    const id = document.getElementById('newEspId').value.trim();
    const label = document.getElementById('newEspLabel').value.trim();
    const maxRelays = parseInt(document.getElementById('newEspMaxRelays').value) || MAX_RELAYS_PER_DEVICE;
    const button = event.target;
    
    if (!id) {
        showNotification('<i class="fas fa-exclamation-circle"></i> Vui lòng nhập ESP ID', 'error');
        return;
    }

    if (!/^[a-zA-Z0-9_-]{3,20}$/.test(id)) {
        showNotification('<i class="fas fa-exclamation-circle"></i> ESP ID chỉ được chứa chữ cái, số, gạch dưới và gạch ngang (3-20 ký tự)', 'error');
        return;
    }

    if (maxRelays < 1 || maxRelays > MAX_RELAYS_PER_DEVICE) {
        showNotification(`<i class="fas fa-exclamation-circle"></i> Số relay tối đa phải từ 1 đến ${MAX_RELAYS_PER_DEVICE}`, 'error');
        return;
    }

    try {
        showButtonLoading(button, true);
        const res = await fetch('/api/esp/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ esp_id: id, label: label || id, max_relays: maxRelays })
        });
        
        if (res.ok) {
            showNotification('<i class="fas fa-check-circle"></i> Thêm thiết bị thành công!', 'success');
            closeAddDeviceModal();
            setTimeout(() => location.reload(), 1000);
        } else {
            const error = await res.json();
            showNotification('<i class="fas fa-exclamation-circle"></i> ' + (error.error || 'Lỗi khi thêm thiết bị'), 'error');
        }
    } catch (error) {
        showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi kết nối đến server', 'error');
    } finally {
        showButtonLoading(button, false);
    }
}

function sendCommand(espId, payload) {
    fetch(`/api/esp/${espId}/cmd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload })
    })
    .then(res => res.json())
    .then(data => {
        if (data.ok) {
            console.log(`✅ Command sent to ${espId}:`, payload);
        } else {
            showNotification(`<i class="fas fa-exclamation-circle"></i> Lỗi: ${data.error}`, 'error');
        }
    })
    .catch(error => {
        showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi kết nối khi gửi lệnh', 'error');
    });
}

function showNotification(message, type = 'info', duration = 5000) {
    const container = document.getElementById('notificationContainer');
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.innerHTML = `
        <div class="notification-content">
            <span class="notification-message">${message}</span>
            <button class="notification-close" onclick="this.parentElement.parentElement.remove()">×</button>
        </div>
    `;
    container.appendChild(notification);
    
    setTimeout(() => {
        if (notification.parentElement) {
            notification.remove();
        }
    }, duration);
}

function updateAllRelaysStatus(espId, statusData) {
    if (statusData.relays) {
        for (let i = 1; i <= MAX_RELAYS_PER_DEVICE; i++) {
            const relayKey = `relay${i}`;
            if (statusData.relays[relayKey]) {
                const status = statusData.relays[relayKey] === 'ON' ? 1 : 0;
                updateRelayUI(espId, i, status);
            }
        }
    }
}

// ==================== CODE GENERATOR FUNCTIONS ====================
function generateDynamicCode() {
    const config = getCodeConfig();
    if (!validateConfig(config)) return;
    
    updateCodeGeneratorWithDynamicRelays(config.espId).then(() => {
        const code = ESP32CodeTemplate.generateDynamicCode(config);
        displayCode(code);
        showNotification('<i class="fas fa-sync-alt"></i> Đã tạo code với cấu hình chân ĐỘNG', 'success');
    });
}

function getCodeConfig() {
    const wifiSSID = document.getElementById('wifiSSID').value.trim();
    const wifiPass = document.getElementById('wifiPass').value.trim();
    const espId = document.getElementById('codeEspId').value.trim();
    const mqttBroker = document.getElementById('mqttBroker').value.trim();
    const mqttPort = document.getElementById('mqttPort').value.trim();
    
    const pins = [];
    document.querySelectorAll('.pin-input').forEach(input => {
        const pinValue = parseInt(input.value);
        pins.push(isNaN(pinValue) ? 0 : pinValue);
    });

    return { 
        wifiSSID, 
        wifiPass, 
        espId, 
        mqttBroker, 
        mqttPort: parseInt(mqttPort) || 1883,
        apiKey: userApiKey,
        pins 
    };
}

function validateConfig(config) {
    const { wifiSSID, wifiPass, espId, mqttBroker, apiKey, pins } = config;
    
    if (!wifiSSID) {
        showNotification('<i class="fas fa-exclamation-circle"></i> Vui lòng nhập WiFi SSID', 'error');
        return false;
    }
    
    if (!wifiPass) {
        showNotification('<i class="fas fa-exclamation-circle"></i> Vui lòng nhập WiFi Password', 'error');
        return false;
    }
    
    if (!espId) {
        showNotification('<i class="fas fa-exclamation-circle"></i> Vui lòng nhập ESP ID', 'error');
        return false;
    }
    
    if (!mqttBroker) {
        showNotification('<i class="fas fa-exclamation-circle"></i> Vui lòng nhập MQTT Broker', 'error');
        return false;
    }

    if (!apiKey) {
        showNotification('<i class="fas fa-exclamation-circle"></i> Vui lòng lấy API Key trước khi tạo code. Nhấn nút "Lấy API Key"', 'error');
        return false;
    }

    if (apiKey === 'Đang tải...' || apiKey.length < 10) {
        showNotification('<i class="fas fa-exclamation-circle"></i> API Key không hợp lệ. Vui lòng lấy API Key lại', 'error');
        return false;
    }
    
    return true;
}

async function updateCodeGeneratorWithDynamicRelays(espId) {
    try {
        const res = await fetch(`/api/esp/${espId}/relays/config`);
        if (res.ok) {
            const data = await res.json();
            if (data.ok) {
                updatePinConfigForCodeGen(data.relays);
            }
        }
    } catch (error) {
        console.error('Error updating code generator:', error);
    }
}

function updatePinConfigForCodeGen(relays) {
    const pinGrid = document.getElementById('pinConfig');
    pinGrid.innerHTML = '';
    
    if (relays.length === 0) {
        pinGrid.innerHTML = `
            <div class="pin-item empty-pin">
                <i class="fas fa-info-circle"></i>
                <span>Chưa có relay nào được cấu hình</span>
                <small>Thêm relay trong tab "Thiết bị" trước</small>
            </div>
        `;
        return;
    }
    
    relays.forEach(relay => {
        pinGrid.innerHTML += `
            <div class="pin-item">
                <label><i class="fas ${relay.icon}"></i> ${relay.name}</label>
                <input type="number" value="${relay.gpio_pin}" min="0" max="39" 
                       class="pin-input" data-relay="${relay.relay_number}" placeholder="GPIO"
                       onchange="validatePin(this)">
                <span class="pin-state valid"><i class="fas fa-check-circle"></i></span>
            </div>
        `;
    });
}

function displayCode(code) {
    const codeElement = document.getElementById('generatedCode');
    codeElement.textContent = code;
    
    try {
        if (typeof Prism !== 'undefined') {
            Prism.highlightAll();
        }
    } catch (error) {
        console.warn('Prism highlighting error:', error);
    }
    
    showNotification('<i class="fas fa-check-circle"></i> Code đã được tạo thành công!', 'success');
}

function copyCode() {
    const code = document.getElementById('generatedCode').textContent;
    if (!code || code.includes('Chọn loại code')) {
        showNotification('<i class="fas fa-exclamation-circle"></i> Chưa có code để copy', 'error');
        return;
    }
    
    navigator.clipboard.writeText(code).then(() => {
        showNotification('<i class="fas fa-check-circle"></i> Code đã được copy vào clipboard!', 'success');
    }).catch(err => {
        showNotification('<i class="fas fa-exclamation-circle"></i> Lỗi khi copy code', 'error');
    });
}

function downloadCode() {
    const code = document.getElementById('generatedCode').textContent;
    if (!code || code.includes('Chọn loại code')) {
        showNotification('<i class="fas fa-exclamation-circle"></i> Chưa có code để tải về', 'error');
        return;
    }
    
    const espId = document.getElementById('codeEspId').value.trim() || 'ESP32';
    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${espId}_MQTT_Relay.ino`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showNotification('<i class="fas fa-check-circle"></i> File đã được tải về!', 'success');
}

function clearCode() {
    if (confirm('Bạn có chắc chắn muốn xóa code đang hiển thị?')) {
        document.getElementById('generatedCode').innerHTML = '<code class="language-cpp">// Nhấn nút "TẠO CODE ĐỘNG" ở trên\n// Code sẽ được tạo tự động với cấu hình của bạn</code>';
        
        try {
            if (typeof Prism !== 'undefined') {
                Prism.highlightAll();
            }
        } catch (error) {
            console.warn('Prism highlighting error:', error);
        }
        
        showNotification('<i class="fas fa-info-circle"></i> Đã xóa code', 'info');
    }
}

// ==================== FORM DATA PERSISTENCE ====================
function saveFormData() {
    const formData = {
        wifiSSID: document.getElementById('wifiSSID').value,
        codeEspId: document.getElementById('codeEspId').value,
        mqttBroker: document.getElementById('mqttBroker').value,
        mqttPort: document.getElementById('mqttPort').value
    };
    localStorage.setItem('esp32Config', JSON.stringify(formData));
}

function loadFormData() {
    const saved = localStorage.getItem('esp32Config');
    if (saved) {
        const formData = JSON.parse(saved);
        document.getElementById('wifiSSID').value = formData.wifiSSID || '';
        document.getElementById('codeEspId').value = formData.codeEspId || '';
        document.getElementById('mqttBroker').value = formData.mqttBroker || 'broker.emqx.io';
        document.getElementById('mqttPort').value = formData.mqttPort || '1883';
    }
}

// ==================== SOCKET.IO REAL-TIME UPDATES ====================
socket.on('esp_status', data => {
    const deviceElements = document.querySelectorAll('.device-item');
    deviceElements.forEach(deviceElement => {
        const deviceId = deviceElement.querySelector('.device-id').textContent;
        if (deviceId === data.id) {
            const statusElement = deviceElement.querySelector('.device-status');
            statusElement.innerHTML = '<i class="fas fa-circle"></i> Online';
            statusElement.className = 'device-status online';
            
            const lastSeenElement = deviceElement.querySelector('.device-meta small:nth-child(2)');
            if (lastSeenElement) {
                lastSeenElement.innerHTML = `<i class="fas fa-clock"></i> Lần cuối: ${formatTimeAgo(data.timestamp)}`;
            }
            
            deviceElement.classList.remove('offline');
            deviceElement.classList.add('online');
        }
    });
    
    try {
        const statusData = JSON.parse(data.status);
        updateAllRelaysStatus(data.id, statusData);
    } catch (e) {
        // Ignore if not JSON
    }
});

socket.on('esp_heartbeat', data => {
    const deviceElements = document.querySelectorAll('.device-item');
    deviceElements.forEach(deviceElement => {
        const deviceId = deviceElement.querySelector('.device-id').textContent;
        if (deviceId === data.id) {
            const lastSeenElement = deviceElement.querySelector('.device-meta small:nth-child(2)');
            if (lastSeenElement) {
                lastSeenElement.innerHTML = `<i class="fas fa-clock"></i> Lần cuối: ${formatTimeAgo(data.timestamp)}`;
            }
        }
    });
});

socket.on('relay_state_updated', data => {
    console.log('🔄 Relay state updated via socket:', data);
    updateRelayUI(data.deviceId, data.relayNumber, data.state ? 1 : 0);
});

socket.on('esp_relay_states', data => {
    console.log('🔄 Multiple relay states updated via socket:', data);
    if (data.id && data.states) {
        updateRelayUIFromStates(data.id, data.states);
    }
});

socket.on('config_synced', data => {
    console.log('🔄 Configuration synced via socket:', data);
    if (data.deviceId && data.success) {
        showNotification(`<i class="fas fa-check-circle"></i> Cấu hình đã được đồng bộ đến ${data.deviceId}`, 'success', 3000);
    }
});

// ==================== EVENT HANDLERS ====================
document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
        checkAuth();
    }
});

window.addEventListener('error', function(e) {
    console.error('Global error:', e.error);
});