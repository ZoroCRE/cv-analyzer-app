// Load environment variables from .env file
require('dotenv').config();

// Import necessary libraries
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const pdf = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Initialize clients
const app = express();
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Setup middleware
app.use(cors()); // Enable Cross-Origin Resource Sharing
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() }); // Store files in memory

// --- HELPER FUNCTIONS ---

/**
 * Extracts text from an image buffer using Gemini API (OCR).
 * @param {Buffer} buffer The image file buffer.
 * @param {string} mimeType The MIME type of the image.
 * @returns {Promise<string|null>} The extracted text or null on failure.
 */
async function getTextFromImage(buffer, mimeType) {
    try {
        const imagePart = {
            inlineData: {
                data: buffer.toString("base64"),
                mimeType,
            },
        };
        const result = await model.generateContent(["Extract all text from this document.", imagePart]);
        return result.response.text();
    } catch (error) {
        console.error("Gemini OCR Error:", error);
        return null;
    }
}

/**
 * Extracts text from a PDF buffer.
 * @param {Buffer} buffer The PDF file buffer.
 * @returns {Promise<string|null>} The extracted text or null on failure.
 */
async function getTextFromPdf(buffer) {
    try {
        const data = await pdf(buffer);
        return data.text;
    } catch (error) {
        console.error("PDF Parse Error:", error);
        return null;
    }
}

/**
 * Analyzes the extracted text using Gemini to get structured data.
 * @param {string} cvText The full text from the CV.
 * @returns {Promise<object|null>} The structured data or null on failure.
 */
async function analyzeCvText(cvText) {
    const prompt = `You are an HR expert. Based on the following CV text, provide a JSON object with the following structure. Do not include any text outside of the JSON object itself.\n\nCV Text:\n${cvText}\n\nJSON Structure:\n{\n  "ATS": "Calculate a percentage score here",\n  "Name": "Extract the full name",\n  "Phone": "Extract the phone number",\n  "Mail": "Extract the email",\n  "Edu": ["List educational degrees"],\n  "SKILLS": [["Skill Category 1", "Details"], ["Skill Category 2", "Details"]],\n  "EXPERIENCE": ["List key experiences or job titles"]\n}`;
    
    try {
        const result = await model.generateContent(prompt);
        const jsonString = result.response.text();
        // Clean the string to ensure it's valid JSON
        const cleanedJsonString = jsonString.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanedJsonString);
    } catch (error) {
        console.error("Gemini Analysis Error:", error);
        return null;
    }
}

// --- API ROUTE ---
app.post('/api/analyze', upload.array('files'), async (req, res) => {
    const { keywords } = req.body;
    const files = req.files;

    if (!files || files.length === 0) {
        return res.status(400).json({ status: 'error', message: 'No files were uploaded.' });
    }

    // 1. Create a submission record in Supabase
    const { data: submissionData, error: submissionError } = await supabase
        .from('submissions')
        .insert([{ keywords: keywords }])
        .select()
        .single();

    if (submissionError || !submissionData) {
        console.error("Supabase submission error:", submissionError);
        return res.status(500).json({ status: 'error', message: 'Failed to create submission record.', details: submissionError });
    }
    const submission_id = submissionData.id;

    // 2. Process each file in parallel
    const processingPromises = files.map(async (file) => {
        let extracted_text = null;
        if (file.mimetype.startsWith('image/')) {
            extracted_text = await getTextFromImage(file.buffer, file.mimetype);
        } else if (file.mimetype === 'application/pdf') {
            extracted_text = await getTextFromPdf(file.buffer);
        }

        if (extracted_text) {
            const analysis_result = await analyzeCvText(extracted_text);
            if (analysis_result) {
                const cv_data_to_insert = {
                    submission_id: submission_id,
                    original_filename: file.originalname,
                    ats_score: analysis_result.ATS || null,
                    candidate_name: analysis_result.Name || null,
                    candidate_email: analysis_result.Mail || null,
                    candidate_phone: analysis_result.Phone || null,
                    education: analysis_result.Edu || [],
                    skills: analysis_result.SKILLS || [],
                    experience: analysis_result.EXPERIENCE || [],
                    full_text: extracted_text
                };
                
                const { error: insertError } = await supabase.from('cv_results').insert([cv_data_to_insert]);
                if (insertError) {
                    console.error("Supabase insert error:", insertError);
                }
            }
        }
    });

    await Promise.all(processingPromises);

    // 3. Send success response
    res.status(200).json({ status: 'success', message: 'Files processed successfully.' });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
