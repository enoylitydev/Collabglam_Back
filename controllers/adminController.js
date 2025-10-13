// controllers/adminController.js
const jwt = require('jsonwebtoken');
const Admin = require('../models/admin');
const Brand = require('../models/brand'); // Assuming you have a Brand model
const Influencer = require('../models/influencer'); // Assuming you have an Influencer model
const Campaign = require('../models/campaign');
const Milestone = require('../models/milestone'); // Assuming you have a Milestone model
/**
 * POST /admin/login
 * body: { email, password }
 */
exports.login = async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        return res.status(400).json({ message: 'Email & password are required' });

    const admin = await Admin.findOne({ email: email.toLowerCase() });
    if (!admin || !(await admin.correctPassword(password))) {
        return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign(
        { adminId: admin.adminId, email: admin.email },
        process.env.JWT_SECRET,
        { expiresIn: '12h' }
    );

    res.json({
        message: 'Login successful',
        token,
        admin: { adminId: admin.adminId, email: admin.email }
    });
};


exports.getAllBrands = async (req, res) => {
    try {
        // 1) Pull pagination, search & sort params from the body
        const page = Math.max(parseInt(req.body.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.body.limit, 10) || 10, 1), 100);
        const search = (req.body.search || '').trim();
        const sortBy = req.body.sortBy || 'name';
        const sortOrder = (req.body.sortOrder || 'asc').toLowerCase();

        // 2) Build filter
        const filter = {};
        if (search) {
            const re = new RegExp(search, 'i');
            filter.$or = [{ name: re }, { email: re }];
        }

        // 3) Count total for meta
        const total = await Brand.countDocuments(filter);

        // 4) Validate sort inputs & build sort object
        const ALLOWED_SORT_FIELDS = ['name', 'email', 'createdAt'];
        const sortField = ALLOWED_SORT_FIELDS.includes(sortBy) ? sortBy : 'name';
        const direction = sortOrder === 'desc' ? -1 : 1;
        const sortObj = { [sortField]: direction };

        // 5) Fetch the page with dynamic sort
        const brands = await Brand.find(filter)
            .select('-password -_id -__v')
            .sort(sortObj)
            .skip((page - 1) * limit)
            .limit(limit)
            .lean();

        // 6) Return structured response
        return res.status(200).json({
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            brands
        });
    } catch (error) {
        console.error('Error in getAllBrands:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};


// controllers/influencerController.js
exports.getList = async (req, res) => {
    try {
        // 1) Pull pagination, search & sort params from the body
        const page = Math.max(parseInt(req.body.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.body.limit, 10) || 10, 1), 100);
        const search = (req.body.search || '').trim();
        const sortBy = req.body.sortBy || 'name';
        const sortOrder = (req.body.sortOrder || 'asc').toLowerCase();

        // 2) Build filter (searching name or email)
        const filter = {};
        if (search) {
            const re = new RegExp(search, 'i');
            filter.$or = [{ name: re }, { email: re }];
        }

        // 3) Get total count for pagination meta
        const total = await Influencer.countDocuments(filter);

        // 4) Validate sort inputs & build sort object
        const ALLOWED_SORT = ['name', 'email', 'createdAt'];
        const field = ALLOWED_SORT.includes(sortBy) ? sortBy : 'name';
        const dir = sortOrder === 'desc' ? -1 : 1;
        const sortObj = { [field]: dir };

        // 5) Fetch the page
        const influencers = await Influencer.find(filter)
            .select('-password -__v')
            .sort(sortObj)
            .skip((page - 1) * limit)
            .limit(limit)
            .lean();

        // 6) Return structured response
        return res.status(200).json({
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            influencers
        });
    } catch (error) {
        console.error('Error fetching influencers:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};


exports.getAllCampaigns = async (req, res) => {
    try {
        // 1) Parse pagination, search, sort & status from body
        const page = Math.max(parseInt(req.body.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.body.limit, 10) || 10, 1), 100);
        const search = (req.body.search || '').trim();
        const sortBy = req.body.sortBy || 'createdAt';
        const sortOrder = (req.body.sortOrder || 'desc').toLowerCase();
        const statusFlag = parseInt(req.body.type, 10) || 0;  // 0 = all, 1 = active, 2 = inactive

        // 2) Build filter
        const filter = {};

        // 2a) text search on brandName, productOrServiceName or description
        if (search) {
            const re = new RegExp(search, 'i');
            filter.$or = [
                { brandName: re },
                { productOrServiceName: re },
                { description: re }
            ];
        }

        // 2b) status filtering on isActive
        if (statusFlag === 1) {
            filter.isActive = 1;
        } else if (statusFlag === 2) {
            filter.isActive = 0;
        }
        // (statusFlag === 0 → no filter)

        // 3) Count for pagination meta
        const total = await Campaign.countDocuments(filter);

        // 4) Validate sort field & direction
        const ALLOWED_SORT = ['brandName', 'productOrServiceName', 'createdAt', 'timeline.startDate', 'timeline.endDate'];
        const field = ALLOWED_SORT.includes(sortBy) ? sortBy : 'createdAt';
        const dir = sortOrder === 'asc' ? 1 : -1;

        // 5) Fetch paged results
        const campaigns = await Campaign.find(filter)
            .select('-__v')
            .sort({ [field]: dir })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean();

        // 6) Return structured response
        return res.status(200).json({
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            status: statusFlag,
            campaigns
        });
    } catch (err) {
        console.error('Error in getAllCampaigns:', err);
        return res.status(500).json({ message: 'Internal server error' });
    }
};


exports.getBrandById = async (req, res) => {
    try {
        const brandId = req.query.id;
        if (!brandId) return res.status(400).json({ message: 'Query parameter id is required.' });

        // exclude password, internal fields
        const brandDoc = await Brand.findOne({ brandId })
            .select('-password -_id -__v')
            .lean();
        if (!brandDoc) return res.status(404).json({ message: 'Brand not found.' });

        // fetch wallet balance
        const milestoneDoc = await Milestone.findOne({ brandId }).lean();
        const walletBalance = milestoneDoc ? milestoneDoc.walletBalance : 0;

        return res.status(200).json({ ...brandDoc, walletBalance });
    } catch (error) {
        console.error('Error in getBrandById:', error);
        return res.status(500).json({ message: 'Internal server error while fetching brand.' });
    }
};

// controllers/influencerController.js
exports.getByInfluencerId = async (req, res) => {
    try {
        // 1) Pull influencerId from query
        const influencerId = req.query.id;
        if (!influencerId) return res.status(400).json({ message: 'Query parameter id is required.' });

        const influencer = await Influencer.findOne(
            { influencerId },
            '-password -__v'
        ).lean();

        if (!influencer) {
            return res.status(404).json({ message: 'Influencer not found' });
        }

        // 3) Send the document back
        return res.status(200).json({ influencer });
    } catch (error) {
        console.error('Error fetching influencer by ID:', error);
        return res
            .status(500)
            .json({ message: 'Internal server error' });
    }
};


exports.getCampaignById = async (req, res) => {
    try {
        const campaignsId = req.query.id;
        if (!campaignsId) {
            return res
                .status(400)
                .json({ message: 'Query parameter id (campaignsId) is required.' });
        }

        const campaign = await Campaign.findOne({ campaignsId }).populate('interestId', 'name');
        if (!campaign) {
            return res.status(404).json({ message: 'Campaign not found.' });
        }
        return res.json(campaign);
    } catch (error) {
        console.error('Error in getCampaignById:', error);
        return res
            .status(500)
            .json({ message: 'Internal server error while fetching campaign.' });
    }
};



exports.getCampaignsByBrandId = async (req, res) => {
  try {
    // 1) Extract & validate brandId
    const {
      brandId,
      page: p = 1,
      limit: l = 10,
      search = '',
      sortBy = 'createdAt',
      sortOrder = 'desc',
      status = 0
    } = req.body;

    if (!brandId) {
      return res
        .status(400)
        .json({ message: 'brandId is required in the request body' });
    }

    // 2) Normalize & build base filter
    const page       = Math.max(parseInt(p, 10), 1);
    const limit      = Math.min(Math.max(parseInt(l, 10), 1), 100);
    const statusFlag = parseInt(status, 10) || 0;
    const filter     = { brandId };

    // 2a) status filtering
    if (statusFlag === 1)      filter.isActive = 1;
    else if (statusFlag === 2) filter.isActive = 0;

    // 2b) text & numeric search across whole schema
    if (search.trim()) {
      const term = search.trim();
      const re   = new RegExp(term, 'i');
      const orClauses = [
        // string fields
        { brandName:            re },
        { productOrServiceName: re },
        { description:          re },
        { 'targetAudience.location': re },
        { interestName:         re },
        { goal:                 re },
        { creativeBriefText:    re },
        { additionalNotes:      re },
        // array-of-strings fields (no $elemMatch)
        { images:       re },
        { creativeBrief:re }
      ];

      // if it's a number, search numeric fields too
      const num = Number(term);
      if (!Number.isNaN(num)) {
        orClauses.push(
          { 'targetAudience.age.MinAge': num },
          { 'targetAudience.age.MaxAge': num },
          { budget:            num },
          { applicantCount:    num }
        );
      }

      filter.$or = orClauses;
    }

    // 3) Count total
    const total = await Campaign.countDocuments(filter);

    // 4) Sort validation
    const ALLOWED_SORT = [
      'brandName',
      'productOrServiceName',
      'createdAt',
      'timeline.startDate',
      'timeline.endDate',
      'budget'
    ];
    const field = ALLOWED_SORT.includes(sortBy) ? sortBy : 'createdAt';
    const dir   = sortOrder.toLowerCase() === 'asc' ? 1 : -1;

    // 5) Fetch paged results
    const campaigns = await Campaign.find(filter)
      .select('-__v')
      .sort({ [field]: dir })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // 6) Respond
    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      status:     statusFlag,
      campaigns
    });
  } catch (err) {
    console.error('Error in getCampaignsByBrandId:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


exports.adminGetInfluencers = async (req, res) => {
  try {
    // 1) Parse and normalize inputs
    const {
      page: p = 1,
      limit: l = 10,
      search = '',
      sortBy = 'createdAt',
      sortOrder = 'desc',

      provider,
      primaryPlatform,
      otpVerified,
      countryId,
      country,
      city,
      gender,
      languageCodes,
      languageIds,
      categoryIds,
      subcategoryIds,
      minFollowers,
      maxFollowers,
      createdFrom,
      createdTo
    } = req.body || {};

    const page  = Math.max(parseInt(p, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(l, 10) || 10, 1), 100);
    const dir   = (String(sortOrder).toLowerCase() === 'asc') ? 1 : -1;

    // 2) Build $match filter (for aggregate)
    const match = {};

    // 2a) Free-text search: uses name/email + prebuilt autocomplete tokens (_ac) + common social fields
    if (search && String(search).trim()) {
      const term = String(search).trim();
      const re   = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

      // Email-like or UUID-like short-circuits
      const ors = [
        { name: re },
        { email: re },
        { _ac: re }, // array of tokens; regex matches any element
        { 'socialProfiles.username': re },
        { 'socialProfiles.fullname': re },
        { 'socialProfiles.handle': re },
        { 'socialProfiles.provider': re },
        { 'socialProfiles.country': re },
        { 'socialProfiles.city': re },
        { 'socialProfiles.categories.categoryName': re },
        { 'socialProfiles.categories.subcategoryName': re },
        { 'languages.name': re },
        { 'languages.code': re },
        { influencerId: re }
      ];
      match.$or = ors;
    }

    // 2b) Scalar filters
    if (provider)        match['socialProfiles.provider'] = provider;
    if (primaryPlatform !== undefined && primaryPlatform !== null)
      match.primaryPlatform = primaryPlatform;

    if (countryId)       match.countryId = countryId;
    if (country)         match.country   = country;
    if (city)            match.city      = city;
    if (gender)          match.gender    = gender;

    // otpVerified (can be boolean or 0/1)
    if (otpVerified !== undefined && otpVerified !== null && otpVerified !== '')
      match.otpVerified = (otpVerified === true || otpVerified === 1 || otpVerified === '1');

    // Language filters
    if (Array.isArray(languageCodes) && languageCodes.length) {
      match['languages.code'] = { $in: languageCodes.map(String) };
    }
    if (Array.isArray(languageIds) && languageIds.length) {
      match['languages.languageId'] = { $in: languageIds.map(String) };
    }

    // Category/Subcategory filters
    if (Array.isArray(categoryIds) && categoryIds.length) {
      match['socialProfiles.categories.categoryId'] = { $in: categoryIds };
    }
    if (Array.isArray(subcategoryIds) && subcategoryIds.length) {
      match['socialProfiles.categories.subcategoryId'] = { $in: subcategoryIds };
    }

    // CreatedAt range
    if (createdFrom || createdTo) {
      match.createdAt = {};
      if (createdFrom) match.createdAt.$gte = new Date(createdFrom);
      if (createdTo)   match.createdAt.$lte = new Date(createdTo);
    }

    // Followers range (across any social profile)
    const followerRange =
      (minFollowers !== undefined && minFollowers !== null) ||
      (maxFollowers !== undefined && maxFollowers !== null);

    if (followerRange) {
      const range = {};
      if (minFollowers !== undefined && minFollowers !== null) range.$gte = Number(minFollowers);
      if (maxFollowers !== undefined && maxFollowers !== null) range.$lte = Number(maxFollowers);

      match.socialProfiles = match.socialProfiles || {};
      match.socialProfiles.$elemMatch = { followers: range };
    }

    // 3) Sorting plan
    const TOP_LEVEL_SORT = new Set(['name', 'email', 'createdAt', 'otpVerified', 'country', 'city']);
    const METRIC_SORT_MAP = {
      followers:       { path: 'socialProfiles.followers',       field: 'metricFollowers' },
      engagements:     { path: 'socialProfiles.engagements',     field: 'metricEngagements' },
      engagementRate:  { path: 'socialProfiles.engagementRate',  field: 'metricEngagementRate' },
      averageViews:    { path: 'socialProfiles.averageViews',    field: 'metricAverageViews' },
      postsCount:      { path: 'socialProfiles.postsCount',      field: 'metricPostsCount' },
      avgLikes:        { path: 'socialProfiles.avgLikes',        field: 'metricAvgLikes' },
      avgComments:     { path: 'socialProfiles.avgComments',     field: 'metricAvgComments' },
      avgViews:        { path: 'socialProfiles.avgViews',        field: 'metricAvgViews' },
      totalLikes:      { path: 'socialProfiles.totalLikes',      field: 'metricTotalLikes' },
      totalViews:      { path: 'socialProfiles.totalViews',      field: 'metricTotalViews' }
    };

    const isTopLevelSort = TOP_LEVEL_SORT.has(sortBy);
    const metricConf = METRIC_SORT_MAP[sortBy];

    // 4) Build aggregation
    const pipeline = [
      { $match: match }
    ];

    // 4a) If sorting by a derived metric, compute max across socialProfiles.*
    if (metricConf) {
      pipeline.push({
        $addFields: {
          [metricConf.field]: {
            $max: {
              $map: {
                input: { $ifNull: ['$socialProfiles', []] },
                as: 'sp',
                in: { $ifNull: [`$$sp.${metricConf.path.split('.').pop()}`, null] }
              }
            }
          }
        }
      });
      pipeline.push({ $sort: { [metricConf.field]: dir, createdAt: -1 } });
    } else if (isTopLevelSort) {
      pipeline.push({ $sort: { [sortBy]: dir, createdAt: -1 } });
    } else {
      // Fallback to createdAt desc if invalid sortBy
      pipeline.push({ $sort: { createdAt: -1 } });
    }

    // 4b) Count documents (facet)
    pipeline.push(
      {
        $facet: {
          data: [
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                password: 0,
                __v: 0
              }
            }
          ],
          meta: [
            { $count: 'total' }
          ]
        }
      },
      {
        $project: {
          data: 1,
          total: { $ifNull: [{ $arrayElemAt: ['$meta.total', 0] }, 0] }
        }
      }
    );

    // 5) Execute
    const [result] = await Influencer.aggregate(pipeline).allowDiskUse(true);
    const influencers = result?.data || [];
    const total = result?.total || 0;

    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      sortBy,
      sortOrder: dir === 1 ? 'asc' : 'desc',
      influencers
    });
  } catch (err) {
    console.error('Error in adminGetInfluencers:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
