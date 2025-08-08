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

// --- CORS CONFIGURATION (CRUCIAL FIX) ---
// We explicitly allow your frontend URL to send requests.
const corsOptions = {
  origin: 'https://cv-dshf.vercel.app', // Your frontend URL
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));


app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() }); // Store files in memory

// --- HELPER FUNCTIONS (getTextFromImage, getTextFromPdf, analyzeCvText) ---
// These functions remain the same.
async function getTextFromImage(buffer, mimeType) {
    try {
        const imagePart = { inlineData: { data: buffer.toString("base64"), mimeType } };
        const result = await model.generateContent(["Extract all text from this document.", imagePart]);
        return result.response.text();
    } catch (error) { console.error("Gemini OCR Error:", error); return null; }
}

async function getTextFromPdf(buffer) {
    try {
        const data = await pdf(buffer);
        return data.text;
    } catch (error) { console.error("PDF Parse Error:", error); return null; }
}

async function analyzeCvText(cvText, keywords) {
    const prompt = `You are an expert HR specialist. Your task is to analyze the provided CV text against the required job skills and qualifications.

Job Requirements (Keywords): "${keywords}"

CV Text:
---
${cvText}
---

Based on the CV text and the job requirements, provide a JSON object with the following structure. Do not include any text outside of the JSON object itself.

JSON Structure:
{
  "ATS": "Calculate a percentage match score based on how well the CV meets the specified Job Requirements. The score should be a string like '85%'.",
  "Name": "Extract the full name",
  "Phone": "Extract the phone number",
  "Mail": "Extract the email",
  "Edu": ["List educational degrees as an array of strings"],
  "SKILLS": [["Skill Category 1", "Details as a string"], ["Skill Category 2", "Details as a string"]],
  "EXPERIENCE": ["List key experiences or job titles as an array of strings"]
}`;
    try {
        const result = await model.generateContent(prompt);
        const jsonString = result.response.text();
        const cleanedJsonString = jsonString.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanedJsonString);
    } catch (error) { console.error("Gemini Analysis Error:", error); return null; }
}


// --- API ROUTES ---

// POST /api/analyze: Receives files and starts analysis
app.post('/api/analyze', upload.array('files'), async (req, res) => {
    const { keywords } = req.body;
    const files = req.files;
    if (!files || files.length === 0) return res.status(400).json({ status: 'error', message: 'No files were uploaded.' });

    const { data: submissionData, error: submissionError } = await supabase
        .from('submissions')
        .insert([{ keywords: keywords }])
        .select()
        .single();

    if (submissionError || !submissionData) {
        return res.status(500).json({ status: 'error', message: 'Failed to create submission record.', details: submissionError });
    }
    const submission_id = submissionData.id;

    // Pass keywords to the background processing function
    processFiles(files, submission_id, keywords);

    // Immediately respond with the submission ID
    res.status(200).json({ status: 'success', submissionId: submission_id });
});

// GET /api/results/:id: Fetches the results for a specific submission
app.get('/api/results/:id', async (req, res) => {
    const { id } = req.params;

    const { data: submission, error: submissionError } = await supabase
        .from('submissions')
        .select('keywords, cv_results(*, skill_details(*), experience_details(*), education_details(*))')
        .eq('id', id)
        .single();

    if (submissionError || !submission) {
        return res.status(404).json({ status: 'error', message: 'Submission not found.' });
    }
    
    // Check if the processing is complete by seeing if cv_results has items
    if (submission.cv_results.length === 0) {
        return res.status(202).json({ status: 'processing', message: 'Analysis is still in progress.' });
    }

    const responseData = {
        status: 'success',
        totalCVs: submission.cv_results.length,
        analysisKeywords: submission.keywords.split(',').map(k => k.trim()),
        results: submission.cv_results.map(cv => ({
            id: cv.id,
            fileName: cv.original_filename,
            matchPercentage: parseInt(cv.ats_score) || 0,
        }))
    };

    res.status(200).json(responseData);
});

// Add a root route for debugging
app.get('/', (req, res) => {
    res.status(200).send('Backend is running!');
});


// --- BACKGROUND PROCESSING FUNCTION ---
async function processFiles(files, submission_id, keywords) {
    for (const file of files) {
        let extracted_text = null;
        if (file.mimetype.startsWith('image/')) {
            extracted_text = await getTextFromImage(file.buffer, file.mimetype);
        } else if (file.mimetype === 'application/pdf') {
            extracted_text = await getTextFromPdf(file.buffer);
        }

        if (extracted_text) {
            const analysis_result = await analyzeCvText(extracted_text, keywords);
            
            if (analysis_result) {
                const score = parseInt(analysis_result.ATS) || 0;

                // First, always insert the main result for the dashboard
                const { data: cvResultData, error: cvError } = await supabase
                    .from('cv_results')
                    .insert([{
                        submission_id: submission_id,
                        original_filename: file.originalname,
                        ats_score: analysis_result.ATS || null,
                        candidate_name: analysis_result.Name || null,
                        candidate_email: analysis_result.Mail || null,
                        candidate_phone: analysis_result.Phone || null,
                        full_text: extracted_text
                    }])
                    .select()
                    .single();
                
                if (cvError || !cvResultData) continue;

                // ONLY if the score is "Very Good" or "Excellent" (> 65), save the detailed data
                if (score > 65) {
                    const cv_result_id = cvResultData.id;

                    if (analysis_result.Edu && Array.isArray(analysis_result.Edu)) {
                        const eduRecords = analysis_result.Edu.map(item => ({ cv_result_id, institution: item }));
                        if(eduRecords.length > 0) await supabase.from('education_details').insert(eduRecords);
                    }
                    if (analysis_result.EXPERIENCE && Array.isArray(analysis_result.EXPERIENCE)) {
                        const expRecords = analysis_result.EXPERIENCE.map(item => ({ cv_result_id, description: item }));
                        if(expRecords.length > 0) await supabase.from('experience_details').insert(expRecords);
                    }
                    if (analysis_result.SKILLS && Array.isArray(analysis_result.SKILLS)) {
                        const skillRecords = analysis_result.SKILLS.map(item => ({ cv_result_id, category: item[0], details: item[1] }));
                        if(skillRecords.length > 0) await supabase.from('skill_details').insert(skillRecords);
                    }
                }
            }
        }
    }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
