// utils/aiGatekeeper.js
// AI Gatekeeper using AWS Bedrock Guardrails to detect and mask PII

const { BedrockRuntimeClient, ApplyGuardrailCommand } = require('@aws-sdk/client-bedrock-runtime');

// Bedrock client with separate credentials for Guardrails
let bedrockClient = null;

function getBedrockClient() {
  if (!bedrockClient) {
    const accessKeyId = process.env.BEDROCK_GUARDRAILS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.BEDROCK_GUARDRAILS_SECRET_ACCESS_KEY;
    const region = process.env.BEDROCK_GUARDRAILS_REGION || 'us-east-1';

    if (!accessKeyId || !secretAccessKey) {
      console.warn('[AI Gatekeeper] Bedrock Guardrails credentials not configured');
      return null;
    }

    bedrockClient = new BedrockRuntimeClient({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }
  return bedrockClient;
}

/**
 * Extract text from HTML (for PII detection)
 */
function extractTextFromHtml(html) {
  if (!html) return '';
  // Remove HTML tags but keep text content
  return String(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mask sensitive content using guardrail detected entities + regex patterns
 */
function maskSensitiveContent(text, guardrailDetectedItems = []) {
  if (!text) return { maskedText: text, matches: [] };

  let maskedText = text;
  const maskedParts = [];
  const itemsToMask = [];

  // First, add items detected by guardrail (these are the most accurate)
  if (guardrailDetectedItems && guardrailDetectedItems.length > 0) {
    guardrailDetectedItems.forEach(item => {
      if (item.match && item.match.trim()) {
        itemsToMask.push({
          original: item.match,
          type: item.type || item.name || 'PII',
          index: text.indexOf(item.match)
        });
      }
    });
  }

  // Then, add regex pattern matches as fallback
  const patterns = [
    {
      name: 'Credit Card',
      regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
      mask: 'XXXXXXXXXXXXXXX'
    },
    {
      name: 'SSN',
      regex: /\b\d{3}-\d{2}-\d{4}\b/g,
      mask: 'XXXXXXXXXXXXXXX'
    },
    {
      name: 'Email',
      regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
      mask: 'XXXXXXXXXXXXXXX'
    },
    {
      name: 'Phone Number',
      regex: /\b(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})\b/g,
      mask: 'XXXXXXXXXXXXXXX'
    },
    {
      name: 'Google Meet Link',
      regex: /https?:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\?[^\s\n\r\t]*)?/gi,
      mask: 'XXXXXXXXXXXXXXX'
    },
    {
      name: 'Instagram Handle',
      regex: /(?:insta|instagram|message\s+in\s+insta|message\s+me|dm\s+me|contact\s+me|find\s+me)\s+(?:on\s+)?(?:@)?([a-zA-Z0-9_]{2,}(?:[._][a-zA-Z0-9_]+)*)/gi,
      mask: 'XXXXXXXXXXXXXXX',
      captureGroup: 1
    },
    {
      name: 'Social Media Username',
      regex: /\b([a-zA-Z][a-zA-Z0-9_]*_[a-zA-Z0-9_]+)\b/g,
      mask: 'XXXXXXXXXXXXXXX',
      captureGroup: 1
    }
  ];

  // Apply regex patterns
  patterns.forEach(pattern => {
    pattern.regex.lastIndex = 0;
    let match;
    
    while ((match = pattern.regex.exec(text)) !== null) {
      const fullMatch = match[0];
      const contentToMask = pattern.captureGroup ? match[pattern.captureGroup] : fullMatch;
      
      // Only add if not already in guardrail items and not duplicate
      const alreadyExists = itemsToMask.some(
        item => item.original === contentToMask && item.index === match.index
      );
      
      if (!alreadyExists) {
        itemsToMask.push({
          original: contentToMask,
          fullMatch: fullMatch,
          index: match.index,
          type: pattern.name
        });
      }
    }
  });

  // Remove duplicates and sort by index (descending) to preserve positions
  const uniqueItems = [];
  const seen = new Set();
  
  itemsToMask.forEach(item => {
    const key = `${item.original}-${item.index}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueItems.push(item);
    }
  });

  uniqueItems.sort((a, b) => {
    // Find actual indices in text
    const aIndex = text.indexOf(a.original, a.index);
    const bIndex = text.indexOf(b.original, b.index);
    return bIndex - aIndex;
  });

  // Mask all items
  uniqueItems.forEach(item => {
    const actualIndex = text.indexOf(item.original);
    if (actualIndex !== -1) {
      const before = maskedText.substring(0, actualIndex);
      const after = maskedText.substring(actualIndex + item.original.length);
      maskedText = before + 'XXXXXXXXXXXXXXX' + after;
      
      maskedParts.push({
        type: item.type,
        original: item.original,
        masked: 'XXXXXXXXXXXXXXX'
      });
    }
  });

  return {
    maskedText,
    matches: maskedParts
  };
}

/**
 * Mask PII in HTML while preserving HTML structure
 */
function maskPIIInHtml(html, guardrailDetectedItems = []) {
  if (!html) return html;

  // Extract text and mask it
  const textContent = extractTextFromHtml(html);
  const textMasking = maskSensitiveContent(textContent, guardrailDetectedItems);
  
  // If no changes, return original
  if (textMasking.maskedText === textContent) return html;

  // Apply masking to HTML by replacing patterns in the original HTML
  let maskedHtml = html;
  
  // Sort matches by index (descending) to preserve positions
  const sortedMatches = [...textMasking.matches].sort((a, b) => {
    // Find indices in original text
    const aIndex = textContent.indexOf(a.original);
    const bIndex = textContent.indexOf(b.original);
    return bIndex - aIndex;
  });

  // Replace in HTML (approximate - searches for the text in HTML)
  sortedMatches.forEach(match => {
    const escapedText = match.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedText, 'gi');
    maskedHtml = maskedHtml.replace(regex, 'XXXXXXXXXXXXXXX');
  });

  return maskedHtml;
}

/**
 * Check content using Bedrock Guardrail (ApplyGuardrail API)
 */
async function checkContentWithGuardrail(text) {
  const client = getBedrockClient();
  if (!client) {
    return { needsMasking: false, reason: 'Bedrock client not configured' };
  }

  const guardrailId = process.env.BEDROCK_GUARDRAILS_ID;
  if (!guardrailId) {
    console.warn('[AI Gatekeeper] BEDROCK_GUARDRAILS_ID not configured');
    return { needsMasking: false, reason: 'Guardrail ID not configured' };
  }

  if (!text || !text.trim()) {
    return { needsMasking: false, reason: 'Empty text' };
  }

  try {
    // Use ApplyGuardrail API directly - same as AWS console
    const command = new ApplyGuardrailCommand({
      guardrailIdentifier: guardrailId,
      guardrailVersion: 'DRAFT',
      source: 'INPUT', // Check input content
      content: [
        {
          text: {
            text: text
          }
        }
      ]
    });

    const response = await client.send(command);
    
    console.log('[AI Gatekeeper] Guardrail Response:', JSON.stringify(response, null, 2));
    
    // ApplyGuardrail API returns action field
    // action: "GUARDRAIL_INTERVENED" means content was blocked
    // action: "NO_ACTION" means content passed
    const action = response.action || '';
    
    console.log('[AI Gatekeeper] Guardrail Action:', action);
    
    // Extract detected PII entities from guardrail response
    let detectedItems = [];
    if (response.assessments && response.assessments.length > 0) {
      const assessment = response.assessments[0];
      
      // Extract PII entities
      if (assessment.sensitiveInformationPolicy) {
        const sip = assessment.sensitiveInformationPolicy;
        
        // Get PII entities
        if (sip.piiEntities && sip.piiEntities.length > 0) {
          sip.piiEntities.forEach(entity => {
            if (entity.match && entity.detected) {
              detectedItems.push({
                match: entity.match,
                type: entity.type || 'PII',
                action: entity.action
              });
            }
          });
        }
        
        // Get regex matches
        if (sip.regexes && sip.regexes.length > 0) {
          sip.regexes.forEach(regex => {
            if (regex.match && regex.detected) {
              detectedItems.push({
                match: regex.match,
                type: regex.name || 'REGEX_MATCH',
                action: regex.action
              });
            }
          });
        }
      }
      
      // Extract word policy matches
      if (assessment.wordPolicy && assessment.wordPolicy.customWords) {
        assessment.wordPolicy.customWords.forEach(word => {
          if (word.match && word.detected) {
            detectedItems.push({
              match: word.match,
              type: 'BLOCKED_WORD',
              action: word.action
            });
          }
        });
      }
    }
    
    console.log('[AI Gatekeeper] Detected items from guardrail:', detectedItems);

    if (action === 'GUARDRAIL_INTERVENED' || action === 'INTERVENED') {
      const reason = 'Content blocked by Bedrock guardrail (GUARDRAIL_INTERVENED)';
      console.log('[AI Gatekeeper] Content blocked by guardrail');
      return { 
        needsMasking: true, 
        reason, 
        guardrailResponse: response,
        detectedItems: detectedItems
      };
    } else if (action === 'NO_ACTION' || action === '') {
      console.log('[AI Gatekeeper] Content passed guardrail check');
      return { 
        needsMasking: false, 
        reason: 'Content passed guardrail check', 
        guardrailResponse: response,
        detectedItems: []
      };
    } else {
      // Unknown action, be safe and mask
      console.warn('[AI Gatekeeper] Unknown guardrail action:', action);
      return { 
        needsMasking: true, 
        reason: `Unknown action: ${action}`, 
        guardrailResponse: response,
        detectedItems: detectedItems
      };
    }
  } catch (error) {
    console.error('[AI Gatekeeper] Guardrail API Error:', error);
    console.error('[AI Gatekeeper] Error Name:', error.name);
    console.error('[AI Gatekeeper] Error Message:', error.message);
    
    // If guardrail blocks content, AWS might throw an error
    if (error.name === 'ValidationException' || 
        error.name === 'AccessDeniedException' ||
        error.message.includes('guardrail') ||
        error.message.includes('Guardrail') ||
        error.message.includes('blocked') ||
        error.message.includes('intervened') ||
        error.message.includes('cannot answer')) {
      return { 
        needsMasking: true, 
        reason: 'Content blocked by guardrail: ' + error.message,
        guardrailResponse: { error: error.message, name: error.name }
      };
    } else {
      // For other errors, log but don't mask (let it through)
      return { 
        needsMasking: false, 
        reason: 'Guardrail check error: ' + error.message,
        guardrailResponse: { error: error.message }
      };
    }
  }
}

/**
 * Main AI Gatekeeper function
 * Detects and masks PII in email content using Bedrock Guardrails
 * 
 * @param {Object} params
 * @param {string} params.subject - Email subject
 * @param {string} params.textBody - Plain text body
 * @param {string} params.htmlBody - HTML body
 * @returns {Promise<Object>} - { subject, textBody, htmlBody, aiGatekeeperDetector }
 */
async function aiGatekeeper({ subject = '', textBody = '', htmlBody = '' }) {
  let aiGatekeeperDetector = false;
  let sanitizedSubject = subject;
  let sanitizedTextBody = textBody;
  let sanitizedHtmlBody = htmlBody;

  try {
    // Combine subject and text body for guardrail check (same as example)
    const fullContent = `${subject}\n\n${textBody}`.trim();
    
    // Check combined content with Guardrail
    let needsMasking = false;
    let contentCheck = { needsMasking: false, detectedItems: [] };
    
    if (fullContent) {
      contentCheck = await checkContentWithGuardrail(fullContent);
      needsMasking = contentCheck.needsMasking;
      
      console.log('[AI Gatekeeper] Content check result:', {
        needsMasking,
        reason: contentCheck.reason
      });
    }

    // If guardrail detected PII, mask subject and body separately
    if (needsMasking) {
      const detectedItems = contentCheck.detectedItems || [];
      
      // Filter detected items that appear in subject
      const subjectDetectedItems = detectedItems.filter(item => 
        subject && subject.includes(item.match)
      );
      
      // Filter detected items that appear in body
      const bodyDetectedItems = detectedItems.filter(item => 
        textBody && textBody.includes(item.match)
      );
      
      // Mask subject using guardrail detected items + regex fallback
      if (subject && subject.trim()) {
        const subjectMasking = maskSensitiveContent(subject, subjectDetectedItems);
        sanitizedSubject = subjectMasking.maskedText;
        if (subjectMasking.matches.length > 0) {
          aiGatekeeperDetector = true;
          console.log('[AI Gatekeeper] Subject masked:', {
            original: subject,
            masked: sanitizedSubject,
            matches: subjectMasking.matches
          });
        }
      }

      // Mask text body using guardrail detected items + regex fallback
      if (textBody && textBody.trim()) {
        const textMasking = maskSensitiveContent(textBody, bodyDetectedItems);
        sanitizedTextBody = textMasking.maskedText;
        if (textMasking.matches.length > 0) {
          aiGatekeeperDetector = true;
          console.log('[AI Gatekeeper] Text body masked:', {
            original: textBody.substring(0, 100),
            masked: sanitizedTextBody.substring(0, 100),
            matches: textMasking.matches.length,
            matchDetails: textMasking.matches
          });
        }
      }

      // Mask HTML body
      if (htmlBody && htmlBody.trim()) {
        // Extract text for masking
        const htmlText = extractTextFromHtml(htmlBody);
        if (htmlText) {
          // Filter detected items that appear in HTML text
          const htmlDetectedItems = detectedItems.filter(item => 
            htmlText.includes(item.match)
          );
          const htmlTextMasking = maskSensitiveContent(htmlText, htmlDetectedItems);
          if (htmlTextMasking.matches.length > 0) {
            // Mask HTML while preserving structure
            sanitizedHtmlBody = maskPIIInHtml(htmlBody, htmlDetectedItems);
            aiGatekeeperDetector = true;
            console.log('[AI Gatekeeper] HTML body masked:', {
              matches: htmlTextMasking.matches.length,
              matchDetails: htmlTextMasking.matches
            });
          }
        }
      }
    } else {
      console.log('[AI Gatekeeper] Content passed guardrail check - no masking needed');
    }
  } catch (error) {
    console.error('[AI Gatekeeper] Error during PII detection:', error);
    // On error, return original content and mark as not detected
    // This ensures emails are not blocked
  }

  return {
    subject: sanitizedSubject,
    textBody: sanitizedTextBody,
    htmlBody: sanitizedHtmlBody,
    aiGatekeeperDetector,
  };
}

module.exports = {
  aiGatekeeper,
};
