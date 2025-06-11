// test/testIoTSystem.js
const mqtt = require('mqtt');

// Test MQTT Publisher (Simulates IoT Energy Meter)
class IoTEnergyMeterSimulator {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.deviceId = 'ENERGY_METER_001';
    this.publishInterval = null;
  }

  connect() {
    const options = {
      host: '13.233.116.100',
      port: 1883,
      username: 'admin',
      password: 'zeroCarbon@123',
      clientId: 'iot_energy_meter_' + Math.random().toString(16).substr(2, 8),
      keepalive: 60,
      clean: true
    };

    console.log('🔌 IoT Energy Meter connecting to MQTT broker...');
    this.client = mqtt.connect(options);

    this.client.on('connect', () => {
      console.log('✅ IoT Energy Meter connected to MQTT broker');
      this.isConnected = true;
      
      // Start publishing energy data every 10 seconds
      this.startPublishing();
    });

    this.client.on('error', (error) => {
      console.error('❌ IoT Energy Meter connection error:', error);
    });

    this.client.on('close', () => {
      console.log('🔌 IoT Energy Meter disconnected');
      this.isConnected = false;
    });
  }

  startPublishing() {
    if (!this.isConnected) return;

    console.log('📡 Starting to publish energy meter data...');
    
    this.publishInterval = setInterval(() => {
      this.publishEnergyData();
    }, 10000); // Publish every 10 seconds

    // Publish first reading immediately
    this.publishEnergyData();
  }

  publishEnergyData() {
    if (!this.isConnected) return;

    // Generate realistic energy meter data
    const energyData = {
      energyValue: parseFloat((Math.random() * 100 + 10).toFixed(2)), // 10-110 kWh
      energy_product_id: this.deviceId,
      userName: this.getRandomUser(),
      timestamp: new Date().toISOString(),
      voltage: parseFloat((220 + Math.random() * 20).toFixed(1)), // 220-240V
      current: parseFloat((Math.random() * 50).toFixed(2)), // 0-50A
      powerFactor: parseFloat((0.8 + Math.random() * 0.2).toFixed(2)) // 0.8-1.0
    };

    // Publish to multiple topics
    const topics = [
      'iot/energy/ENERGY_METER_001/data',
      'iot/meters/ENERGY_METER_001/reading',
      'zerohero/iot/energy'
    ];

    topics.forEach(topic => {
      this.client.publish(topic, JSON.stringify(energyData), { qos: 1 }, (err) => {
        if (!err) {
          console.log(`📤 Published to ${topic}:`, energyData);
        } else {
          console.error(`❌ Failed to publish to ${topic}:`, err);
        }
      });
    });
  }

  getRandomUser() {
    const users = ['john_doe', 'jane_smith', 'bob_wilson', 'alice_brown', 'charlie_davis'];
    return users[Math.floor(Math.random() * users.length)];
  }

  stopPublishing() {
    if (this.publishInterval) {
      clearInterval(this.publishInterval);
      this.publishInterval = null;
      console.log('⏹️ Stopped publishing energy data');
    }
  }

  disconnect() {
    this.stopPublishing();
    if (this.client && this.isConnected) {
      this.client.end();
      console.log('🔌 IoT Energy Meter disconnected');
    }
  }

  // Publish a single test message
  publishTestMessage() {
    if (!this.isConnected) {
      console.log('❌ Not connected to MQTT broker');
      return;
    }

    const testData = {
      energyValue: 55.67,
      energy_product_id: 'TEST_METER_999',
      userName: 'test_user'
    };

    this.client.publish('zerohero/iot/energy', JSON.stringify(testData), { qos: 1 }, (err) => {
      if (!err) {
        console.log('✅ Test message published successfully:', testData);
      } else {
        console.error('❌ Failed to publish test message:', err);
      }
    });
  }
}

// Test API endpoints
async function testAPIEndpoints() {
  console.log('\n🧪 Testing API endpoints...');
  
  const baseURL = 'http://localhost:5000/api';
  
  try {
    // Test 1: Health check
    console.log('Testing health endpoint...');
    const healthResponse = await fetch(`${baseURL}/health`);
    const healthData = await healthResponse.json();
    console.log('✅ Health check:', healthData);

    // Test 2: MQTT status
    console.log('Testing MQTT status...');
    const mqttResponse = await fetch(`${baseURL}/mqtt/status`);
    const mqttData = await mqttResponse.json();
    console.log('✅ MQTT status:', mqttData);

    // Test 3: Socket.IO status
    console.log('Testing Socket.IO status...');
    const socketResponse = await fetch(`${baseURL}/socket/status`);
    const socketData = await socketResponse.json();
    console.log('✅ Socket.IO status:', socketData);

    // Test 4: POST IoT data
    console.log('Testing POST IoT data...');
    const iotResponse = await fetch(`${baseURL}/iotdata`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        energyValue: 123.45,
        energy_product_id: 'API_TEST_METER',
        userName: 'api_test_user'
      })
    });
    const iotData = await iotResponse.json();
    console.log('✅ POST IoT data:', iotData);

    // Test 5: GET IoT data
    console.log('Testing GET IoT data...');
    const getResponse = await fetch(`${baseURL}/iotdata?limit=5`);
    const getData = await getResponse.json();
    console.log('✅ GET IoT data:', getData);

  } catch (error) {
    console.error('❌ API test error:', error);
  }
}

// Socket.IO client test
function testSocketIOClient() {
  console.log('\n🔌 Testing Socket.IO client...');
  
  const io = require('socket.io-client');
  const socket = io('http://localhost:5000');

  socket.on('connect', () => {
    console.log('✅ Socket.IO client connected');
    
    // Request latest IoT data
    socket.emit('requestLatestIoTData');
  });

  socket.on('welcome', (data) => {
    console.log('📨 Welcome message:', data);
  });

  socket.on('newIoTData', (data) => {
    console.log('📨 New IoT data received:', data);
  });

  socket.on('latestIoTData', (data) => {
    console.log('📨 Latest IoT data:', data);
  });

  socket.on('disconnect', () => {
    console.log('🔌 Socket.IO client disconnected');
  });

  // Disconnect after 30 seconds
  setTimeout(() => {
    socket.disconnect();
  }, 30000);
}

// Main test execution
async function runTests() {
  console.log('🚀 Starting IoT System Tests...\n');

  // Test 1: API endpoints
  await testAPIEndpoints();
  
  // Wait a bit
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Test 2: Socket.IO client
  testSocketIOClient();
  
  // Wait a bit more
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Test 3: IoT Energy Meter Simulator
  console.log('\n🏭 Starting IoT Energy Meter Simulator...');
  const simulator = new IoTEnergyMeterSimulator();
  simulator.connect();

  // Run simulator for 60 seconds
  setTimeout(() => {
    console.log('\n⏹️ Stopping IoT Energy Meter Simulator...');
    simulator.disconnect();
    
    console.log('\n✅ All tests completed!');
    process.exit(0);
  }, 60000);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Test interrupted, shutting down...');
    simulator.disconnect();
    process.exit(0);
  });
}

// Command line interface
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.includes('--api-only')) {
    testAPIEndpoints();
  } else if (args.includes('--mqtt-only')) {
    const simulator = new IoTEnergyMeterSimulator();
    simulator.connect();
    
    // Publish a single test message after connection
    setTimeout(() => {
      simulator.publishTestMessage();
    }, 2000);
    
    // Keep running until interrupted
    process.on('SIGINT', () => {
      simulator.disconnect();
      process.exit(0);
    });
  } else if (args.includes('--socket-only')) {
    testSocketIOClient();
  } else {
    runTests();
  }
}

module.exports = {
  IoTEnergyMeterSimulator,
  testAPIEndpoints,
  testSocketIOClient
};

// Usage examples:
// node testIoTSystem.js              // Run all tests
// node testIoTSystem.js --api-only   // Test API endpoints only
// node testIoTSystem.js --mqtt-only  // Test MQTT publishing only
// node testIoTSystem.js --socket-only // Test Socket.IO only


