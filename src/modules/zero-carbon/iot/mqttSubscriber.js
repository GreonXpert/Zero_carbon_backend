// mqtt/mqttSubscriber.js
const mqtt = require('mqtt');
const { handleMQTTData } = require('./iotController');

class MQTTSubscriber {
  constructor() {
    this.client = null;
    this.isConnected = false;
  }

  connect() {
    // MQTT broker configuration
    const options = {
      host: '13.233.116.100',
      port: 1883,
      username: 'admin',
      password: 'zeroCarbon@123',
      clientId: 'nodejs_iot_subscriber_' + Math.random().toString(16).substr(2, 8),
      keepalive: 60,
      reconnectPeriod: 5000, // Auto-reconnect every 5 seconds
      clean: true
    };

    console.log('🔌 Connecting to MQTT broker...');
    this.client = mqtt.connect(options);

    // Connection established
    this.client.on('connect', () => {
      console.log('✅ Connected to MQTT broker successfully');
      this.isConnected = true;
      
      // Subscribe to IoT energy meter topics
      const topics = [
        'iot/energy/+/data',        // iot/energy/{deviceId}/data
        'iot/meters/+/reading',     // iot/meters/{meterId}/reading
        'energy/meter/data',        // General energy meter data
        'zerocarbon/iot/energy'       // Your specific topic
      ];

      topics.forEach(topic => {
        this.client.subscribe(topic, { qos: 1 }, (err) => {
          if (!err) {
            console.log(`📡 Subscribed to topic: ${topic}`);
          } else {
            console.error(`❌ Failed to subscribe to ${topic}:`, err);
          }
        });
      });

      // Send connection status
      this.client.publish('zerocarbon/status', JSON.stringify({
        service: 'nodejs-iot-subscriber',
        status: 'connected',
        timestamp: new Date().toISOString()
      }));
    });

    // Message received
    this.client.on('message', async (topic, message) => {
      try {
        console.log(`📨 Received message on topic: ${topic}`);
        console.log(`📄 Raw message: ${message.toString()}`);

        // Parse JSON message
        const data = JSON.parse(message.toString());
        
        // Validate message structure
        if (this.isValidEnergyData(data)) {
          // Handle the data using our controller
          const result = await handleMQTTData(data);
          
          if (result) {
            console.log('✅ Successfully processed IoT data from MQTT');
          } else {
            console.log('❌ Failed to process IoT data from MQTT');
          }
        } else {
          console.log('⚠️ Invalid energy data format received:', data);
        }

      } catch (error) {
        console.error('❌ Error processing MQTT message:', error);
        console.log('📄 Problematic message:', message.toString());
      }
    });

    // Connection error
    this.client.on('error', (error) => {
      console.error('❌ MQTT connection error:', error);
      this.isConnected = false;
    });

    // Connection closed
    this.client.on('close', () => {
      console.log('🔌 MQTT connection closed');
      this.isConnected = false;
    });

    // Reconnecting
    this.client.on('reconnect', () => {
      console.log('🔄 Reconnecting to MQTT broker...');
    });

    // Offline
    this.client.on('offline', () => {
      console.log('📴 MQTT client is offline');
      this.isConnected = false;
    });
  }

  // Validate if the received data is valid energy meter data
  isValidEnergyData(data) {
    return (
      data &&
      typeof data === 'object' &&
      typeof data.energyValue === 'number' &&
      typeof data.energy_product_id === 'string' &&
      typeof data.userName === 'string' &&
      data.energyValue >= 0 &&
      data.energy_product_id.length > 0 &&
      data.userName.length > 0
    );
  }

  // Disconnect from MQTT broker
  disconnect() {
    if (this.client && this.isConnected) {
      this.client.end();
      console.log('🔌 Disconnected from MQTT broker');
    }
  }

  // Get connection status
  getStatus() {
    return {
      connected: this.isConnected,
      clientId: this.client ? this.client.options.clientId : null
    };
  }

  // Publish test message
  publishTest() {
    if (this.client && this.isConnected) {
      const testData = {
        energyValue: Math.random() * 100,
        energy_product_id: 'TEST_METER_001',
        userName: 'testUser',
        timestamp: new Date().toISOString()
      };

      this.client.publish('zerocarbon/iot/energy', JSON.stringify(testData));
      console.log('📤 Published test message:', testData);
    }
  }
}

module.exports = MQTTSubscriber;

