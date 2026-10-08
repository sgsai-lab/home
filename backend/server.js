require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, validationResult, matchedData } = require('express-validator');
const xss = require('xss-clean');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

// Security: Helmet adds secure HTTP headers
app.use(helmet());

// Security: No API keys in client-side JavaScript. 
// Any external service keys (e.g., SendGrid, Mailgun) are stored in server-side .env
const EMAIL_API_KEY = process.env.EMAIL_API_KEY;

// Middleware to parse JSON
app.use(express.json({ limit: '10kb' })); // Restrict payload size

// Security: Sanitize incoming data against XSS
app.use(xss());

// Security: Rate limiting to prevent abuse and cost escalation
const contactRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: { error: 'Too many requests from this IP, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Endpoint: POST /api/contact
app.post('/api/contact', contactRateLimiter, [
  // Security: Validate and sanitise every field server-side; never trust the client.
  body('name')
    .trim()
    .notEmpty().withMessage('Name is required.')
    .isLength({ max: 100 }).withMessage('Name is too long.')
    .escape(),
    
  body('email')
    .trim()
    .notEmpty().withMessage('Email is required.')
    .isEmail().withMessage('Valid email is required.')
    .normalizeEmail(),
    
  body('phone')
    .optional({ checkFalsy: true })
    .trim()
    .matches(/^[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}$/im)
    .withMessage('Invalid phone number format.')
    .escape(),
    
  body('subject')
    .trim()
    .notEmpty().withMessage('Subject is required.')
    .isLength({ max: 150 }).withMessage('Subject is too long.')
    .escape(),
    
  body('message')
    .trim()
    .notEmpty().withMessage('Message is required.')
    .isLength({ max: 2000 }).withMessage('Message is too long.')
    .escape()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Return only generic validation errors, don't expose internal stack traces
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  // Store or forward only what is needed
  // We strictly use matchedData to ignore any extra malicious fields sent in the request
  const validData = matchedData(req);

  try {
    // NOTE: Forward data to your email service provider securely here.
    // e.g., await sendEmail(EMAIL_API_KEY, validData.email, validData.message);
    
    // Simulate async email forwarding
    await new Promise(resolve => setTimeout(resolve, 500));

    // Do NOT store data locally unless strictly required and explicitly stated in the Privacy Policy.
    
    res.status(200).json({ message: 'Message securely forwarded.' });
  } catch (err) {
    console.error('Email forwarding failed:', err);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

app.listen(PORT, () => {
  console.log(`Secure Contact API running on port ${PORT}`);
});
