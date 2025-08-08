Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
    if (!supabaseUrl || !supabaseAnonKey || !geminiApiKey) {
      return new Response(JSON.stringify({ error: 'Missing environment variables' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      });
    }
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: req.headers.get('Authorization')! } } });

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      });
    }

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const formData = await req.formData();
    const files = formData.getAll('files') as File[];
    const keywords = formData.get('keywords') as string;

    if (!files || files.length === 0) {
      return new Response(JSON.stringify({ error: 'No files were uploaded.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data: submissionData, error: submissionError } = await supabaseClient
      .from('submissions')
      .insert([{ keywords: keywords, user_id: user.id }])
      .select()
      .single();

    if (submissionError) throw submissionError;
    const submission_id = submissionData.id;

    (async () => {
      try {
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
      } catch (error) {
        console.error("Background processing error:", error);
      }
    })();

    return new Response(JSON.stringify({ status: 'success', submissionId: submission_id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    });
  }
});
