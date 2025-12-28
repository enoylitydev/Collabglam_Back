// controllers/bedrockTestController.js
// Test endpoint for Bedrock API

const { aiGatekeeper } = require('../utils/aiGatekeeper');

/**
 * POST /test/bedrock
 * Test Bedrock API directly
 */
exports.testBedrock = async (req, res) => {
  try {
    const { text, subject, htmlBody } = req.body;

    if (!text && !subject && !htmlBody) {
      return res.status(400).json({
        error: 'Please provide at least one of: text, subject, or htmlBody'
      });
    }

    console.log('[Bedrock Test] Testing with:', { text, subject, htmlBody });

    const result = await aiGatekeeper({
      subject: subject || '',
      textBody: text || '',
      htmlBody: htmlBody || '',
    });

    return res.status(200).json({
      success: true,
      input: {
        subject: subject || '',
        text: text || '',
        htmlBody: htmlBody || '',
      },
      output: {
        subject: result.subject,
        textBody: result.textBody,
        htmlBody: result.htmlBody,
        aiGatekeeperDetector: result.aiGatekeeperDetector,
      },
      masked: result.aiGatekeeperDetector,
      message: result.aiGatekeeperDetector 
        ? 'PII detected and masked' 
        : 'No PII detected or Bedrock API not available'
    });
  } catch (err) {
    console.error('[Bedrock Test] Error:', err);
    return res.status(500).json({
      error: err.message || 'Internal server error',
      details: err.stack
    });
  }
};

