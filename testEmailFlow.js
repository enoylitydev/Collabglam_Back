// testEmailFlow.js
// Quick test script for email proxy and AI Gatekeeper

require('dotenv').config();
const fetch = require('node-fetch');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

async function testGatekeeper() {
  console.log('\n🧪 Testing AI Gatekeeper...\n');
  
  const testCases = [
    {
      name: 'Test with PII (Phone, Email)',
      data: {
        subject: 'Test Email',
        text: 'Hi, my phone is 555-123-4567 and email is john@gmail.com',
        htmlBody: '<p>Hi, my phone is 555-123-4567 and email is john@gmail.com</p>'
      }
    },
    {
      name: 'Test with Credit Card',
      data: {
        text: 'My credit card is 4532-1234-5678-9010'
      }
    },
    {
      name: 'Test without PII',
      data: {
        text: 'This is a normal message without any sensitive information.'
      }
    }
  ];

  for (const testCase of testCases) {
    try {
      console.log(`\n📝 ${testCase.name}`);
      console.log('Input:', JSON.stringify(testCase.data, null, 2));
      
      const response = await fetch(`${BASE_URL}/test/bedrock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testCase.data)
      });

      const result = await response.json();
      
      if (result.success) {
        console.log('✅ Success');
        console.log('Output:', JSON.stringify(result.output, null, 2));
        console.log('PII Detected:', result.masked ? 'YES' : 'NO');
      } else {
        console.log('❌ Failed:', result.error);
      }
    } catch (err) {
      console.error('❌ Error:', err.message);
    }
  }
}

async function testInboundEmail() {
  console.log('\n\n🧪 Testing Inbound Email Handler (Simulates Gmail Reply)...\n');
  
  const testEmail = {
    from: 'test@gmail.com',
    fromName: 'Test User',
    to: 'test@mail.collabglam.com', // Replace with actual proxy email from your DB
    subject: 'Re: Test Email',
    text: 'Hi, my phone number is 555-123-4567. Please call me!',
    html: '<p>Hi, my phone number is 555-123-4567. Please call me!</p>',
    messageId: `test-${Date.now()}`
  };

  try {
    console.log('📝 Sending test email...');
    console.log('From:', testEmail.from);
    console.log('To:', testEmail.to);
    console.log('Content:', testEmail.text);
    
    const response = await fetch(`${BASE_URL}/emails/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testEmail)
    });

    const result = await response.json();
    
    if (response.ok) {
      console.log('✅ Email processed successfully');
      console.log('Result:', JSON.stringify(result, null, 2));
    } else {
      console.log('❌ Failed:', result.error || result.message);
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.log('\n💡 Tip: Make sure:');
    console.log('   1. Server is running on', BASE_URL);
    console.log('   2. MongoDB is connected');
    console.log('   3. EmailThread exists for the proxy email');
  }
}

async function checkServer() {
  console.log('🔍 Checking if server is running...\n');
  
  try {
    const response = await fetch(`${BASE_URL}/test/bedrock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'test' })
    });
    
    if (response.ok || response.status === 400) {
      console.log('✅ Server is running on', BASE_URL);
      return true;
    } else {
      console.log('❌ Server returned status:', response.status);
      return false;
    }
  } catch (err) {
    console.log('❌ Cannot connect to server:', err.message);
    console.log('\n💡 Make sure:');
    console.log('   1. Server is running: npm run dev');
    console.log('   2. Base URL is correct:', BASE_URL);
    return false;
  }
}

async function main() {
  console.log('🚀 Email Proxy & AI Gatekeeper Test Suite\n');
  console.log('='.repeat(50));
  
  const serverRunning = await checkServer();
  
  if (!serverRunning) {
    console.log('\n❌ Cannot proceed without server connection');
    process.exit(1);
  }
  
  // Test AI Gatekeeper
  await testGatekeeper();
  
  // Test Inbound Email Handler
  await testInboundEmail();
  
  console.log('\n\n' + '='.repeat(50));
  console.log('✅ Test suite complete!');
  console.log('\n💡 Next steps:');
  console.log('   1. Check MongoDB for saved messages');
  console.log('   2. Verify PII masking worked');
  console.log('   3. Test with real email addresses');
}

// Run tests
main().catch(console.error);









