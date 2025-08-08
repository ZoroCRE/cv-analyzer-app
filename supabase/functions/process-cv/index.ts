import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { GoogleGenerativeAI } from 'https://esm.sh/@google/generative-ai@0.14.1'
import pdf from 'https://esm.sh/pdf-parse@1.1.1'

// --- HELPER FUNCTIONS ---
async function getTextFromImage(buffer: ArrayBuffer, mimeType: string, genAI: GoogleGenerativeAI) {
    // ... (Logic for image text extraction)
}
async function getTextFromPdf(buffer: ArrayBuffer) {
    // ... (Logic for PDF text extraction)
}
async function analyzeCvText(cvText: string, keywords: string, genAI: GoogleGenerativeAI) {
    // ... (Logic for Gemini analysis)
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
    if (!user) throw new Error('Unauthorized');

    const genAI = new GoogleGenerativeAI(Deno.env.get('GEMINI_API_KEY')!);

    const formData = await req.formData();
    const files = formData.getAll('files') as File[];
    const keywords = formData.get('keywords') as string;

    if (!files || files.length === 0) throw new Error('No files were uploaded.');

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
            // ... (Full file processing logic as defined before)
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
