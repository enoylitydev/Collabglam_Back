const FAQ = require('../models/faqs');
const { v4: uuidv4 } = require('uuid');

/**
 * Create or update the full FAQ page
 * POST /api/faq/save
 */
exports.saveFAQPage = async (req, res) => {
  try {
    const {
      title,
      shortDescription,
      introText,
      contactHeading,
      contactText,
      effectiveDate,
      isPublished,
      items
    } = req.body;

    if (!shortDescription || !introText || !contactText || !effectiveDate) {
      return res.status(400).json({
        message: 'shortDescription, introText, contactText, and effectiveDate are required.'
      });
    }

    const normalizedItems = Array.isArray(items)
      ? items.map((item, index) => ({
          faqId: item.faqId || uuidv4(),
          sectionKey: item.sectionKey,
          sectionTitle: item.sectionTitle,
          question: item.question,
          answer: item.answer,
          displayOrder: item.displayOrder ?? index + 1,
          isPublished: item.isPublished ?? true,
          createdAt: item.createdAt || new Date(),
          updatedDate: new Date()
        }))
      : [];

    const faqPage = await FAQ.findOneAndUpdate(
      { pageKey: 'main_faq' },
      {
        $set: {
          title: title || 'CollabGlam Frequently Asked Questions (FAQ)',
          shortDescription,
          introText,
          contactHeading: contactHeading || 'Contact Information',
          contactText,
          effectiveDate,
          isPublished: isPublished ?? true,
          items: normalizedItems,
          updatedDate: new Date()
        }
      },
      { new: true, upsert: true }
    );

    return res.json(faqPage);
  } catch (error) {
    console.error('Error saving FAQ page:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

/**
 * Get public FAQ page
 * GET /api/faq/get
 */
exports.getFAQPage = async (req, res) => {
  try {
    const faqPage = await FAQ.findOne({ pageKey: 'main_faq', isPublished: true });

    if (!faqPage) {
      return res.status(404).json({ message: 'FAQ page not found.' });
    }

    const publishedItems = faqPage.items
      .filter(item => item.isPublished)
      .sort((a, b) => a.displayOrder - b.displayOrder);

    return res.json({
      ...faqPage.toObject(),
      items: publishedItems
    });
  } catch (error) {
    console.error('Error fetching FAQ page:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

/**
 * Get admin FAQ page
 * GET /api/faq/admin/get
 */
exports.getFAQPageAdmin = async (req, res) => {
  try {
    const faqPage = await FAQ.findOne({ pageKey: 'main_faq' });

    if (!faqPage) {
      return res.status(404).json({ message: 'FAQ page not found.' });
    }

    return res.json(faqPage);
  } catch (error) {
    console.error('Error fetching admin FAQ page:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

/**
 * Add one FAQ item
 * POST /api/faq/item/add
 */
exports.addFAQItem = async (req, res) => {
  try {
    const {
      sectionKey,
      sectionTitle,
      question,
      answer,
      displayOrder,
      isPublished
    } = req.body;

    if (!sectionKey || !sectionTitle || !question || !answer) {
      return res.status(400).json({
        message: 'sectionKey, sectionTitle, question, and answer are required.'
      });
    }

    const faqPage = await FAQ.findOne({ pageKey: 'main_faq' });
    if (!faqPage) {
      return res.status(404).json({ message: 'FAQ page not found.' });
    }

    faqPage.items.push({
      faqId: uuidv4(),
      sectionKey,
      sectionTitle,
      question,
      answer,
      displayOrder: displayOrder ?? faqPage.items.length + 1,
      isPublished: isPublished ?? true,
      createdAt: new Date(),
      updatedDate: new Date()
    });

    faqPage.updatedDate = new Date();
    await faqPage.save();

    return res.json(faqPage);
  } catch (error) {
    console.error('Error adding FAQ item:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

/**
 * Update one FAQ item
 * POST /api/faq/item/update
 */
exports.updateFAQItem = async (req, res) => {
  try {
    const {
      faqId,
      sectionKey,
      sectionTitle,
      question,
      answer,
      displayOrder,
      isPublished
    } = req.body;

    if (!faqId) {
      return res.status(400).json({ message: 'faqId is required.' });
    }

    const faqPage = await FAQ.findOne({ pageKey: 'main_faq' });
    if (!faqPage) {
      return res.status(404).json({ message: 'FAQ page not found.' });
    }

    const item = faqPage.items.find(f => f.faqId === faqId);
    if (!item) {
      return res.status(404).json({ message: 'FAQ item not found.' });
    }

    if (sectionKey !== undefined) item.sectionKey = sectionKey;
    if (sectionTitle !== undefined) item.sectionTitle = sectionTitle;
    if (question !== undefined) item.question = question;
    if (answer !== undefined) item.answer = answer;
    if (displayOrder !== undefined) item.displayOrder = displayOrder;
    if (isPublished !== undefined) item.isPublished = isPublished;

    item.updatedDate = new Date();
    faqPage.updatedDate = new Date();

    await faqPage.save();
    return res.json(faqPage);
  } catch (error) {
    console.error('Error updating FAQ item:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

/**
 * Delete one FAQ item
 * POST /api/faq/item/delete
 */
exports.deleteFAQItem = async (req, res) => {
  try {
    const { faqId } = req.body;

    if (!faqId) {
      return res.status(400).json({ message: 'faqId is required.' });
    }

    const faqPage = await FAQ.findOne({ pageKey: 'main_faq' });
    if (!faqPage) {
      return res.status(404).json({ message: 'FAQ page not found.' });
    }

    const initialLength = faqPage.items.length;
    faqPage.items = faqPage.items.filter(item => item.faqId !== faqId);

    if (faqPage.items.length === initialLength) {
      return res.status(404).json({ message: 'FAQ item not found.' });
    }

    faqPage.updatedDate = new Date();
    await faqPage.save();

    return res.json({ message: 'FAQ item deleted successfully.', faqPage });
  } catch (error) {
    console.error('Error deleting FAQ item:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};