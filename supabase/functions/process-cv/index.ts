import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { GoogleGenerativeAI } from 'https://esm.sh/@google/generative-ai@0.14.1'
import pdf from 'https://esm.sh/pdf-parse@1.1.1'


// --- HELPER FUNCTIONS ---

async function getTextFromImage(buffer: ArrayBuffer, mimeType: string, genAI: GoogleGenerativeAI) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro-vision" });
        const imagePart = {
            inlineData: {
                data: btoa(new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')),
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

async function getTextFromPdf(buffer: ArrayBuffer) {
    try {
        // The 'pdf-parse' library expects a Buffer, which Deno can work with via Uint8Array
        const data = await pdf(new Uint8Array(buffer));
        return data.text;
    } catch (error) {
        console.error("PDF Parse Error:", error);
        return null;
    }
}

async function analyzeCvText(cvText: string, keywords: string, genAI: GoogleGenerativeAI) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
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
    } catch (error) {
        console.error("Gemini Analysis Error:", error);
        return null;
    }
}


// --- MAIN FUNCTION ---

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    )

    const { data: { user } } = await supabaseClient.auth.getUser()
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      })
    }
    
    // Initialize Gemini AI client using environment variables
    const genAI = new GoogleGenerativeAI(Deno.env.get('GEMINI_API_KEY')!);

    const formData = await req.formData();
    const files = formData.getAll('files') as File[];
    const keywords = formData.get('keywords') as string;

    if (!files || files.length === 0) {
      return new Response(JSON.stringify({ error: 'No files were uploaded.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Create a single submission record for this batch
    const { data: submissionData, error: submissionError } = await supabaseClient
        .from('submissions')
        .insert([{ keywords: keywords, user_id: user.id }])
        .select()
        .single();

    if (submissionError) throw submissionError;
    const submission_id = submissionData.id;

    // Process files in the background (don't await this loop)
    (async () => {
        for (const file of files) {
            const fileBuffer = await file.arrayBuffer();
            let extracted_text = null;

            if (file.type.startsWith('image/')) {
                extracted_text = await getTextFromImage(fileBuffer, file.type, genAI);
            } else if (file.type === 'application/pdf') {
                extracted_text = await getTextFromPdf(fileBuffer);
            }

            if (extracted_text) {
                const analysis_result = await analyzeCvText(extracted_text, keywords, genAI);
                if (analysis_result) {
                    const score = parseInt(analysis_result.ATS) || 0;

                    const { data: cvResultData, error: cvError } = await supabaseClient
                        .from('cv_results')
                        .insert([{
                            submission_id: submission_id,
                            original_filename: file.name,
                            ats_score: analysis_result.ATS || null,
                            candidate_name: analysis_result.Name || null,
                            candidate_email: analysis_result.Mail || null,
                            candidate_phone: analysis_result.Phone || null,
                            full_text: extracted_text
                        }])
                        .select()
                        .single();
                    
                    if (cvError) {
                        console.error(`Error saving main CV data for ${file.name}:`, cvError);
                        continue; 
                    }

                    if (score > 65) {
                        const cv_result_id = cvResultData.id;
                        if (analysis_result.Edu?.length) {
                            const eduRecords = analysis_result.Edu.map((item: string) => ({ cv_result_id, institution: item }));
                            await supabaseClient.from('education_details').insert(eduRecords);
                        }
                        if (analysis_result.EXPERIENCE?.length) {
                            const expRecords = analysis_result.EXPERIENCE.map((item: string) => ({ cv_result_id, description: item }));
                            await supabaseClient.from('experience_details').insert(expRecords);
                        }
                        if (analysis_result.SKILLS?.length) {
                            const skillRecords = analysis_result.SKILLS.map((item: string[]) => ({ cv_result_id, category: item[0], details: item[1] }));
                            await supabaseClient.from('skill_details').insert(skillRecords);
                        }
                    }
                }
            }
        }
    })();
    
    return new Response(JSON.stringify({ status: 'success', submissionId: submission_id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
