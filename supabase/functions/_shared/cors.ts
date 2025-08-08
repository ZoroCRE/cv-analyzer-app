const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: req.headers.get('Authorization')! } } });
console.log(`Requesting: ${supabaseUrl}/functions/v1/process-cv`);
