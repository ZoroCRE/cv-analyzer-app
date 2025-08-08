import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Create a Supabase client with the user's authorization
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    )

    // 1. Authenticate the user
    const { data: { user } } = await supabaseClient.auth.getUser()
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      })
    }

    // 2. Check user's credits
    const { data: profile, error: profileError } = await supabaseClient
      .from('profiles')
      .select('credits')
      .eq('id', user.id)
      .single()

    if (profileError || !profile) {
      throw new Error('Could not retrieve user profile.')
    }

    if (profile.credits <= 0) {
      return new Response(JSON.stringify({ error: 'Insufficient credits' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 402,
      })
    }

    // 3. Handle Keywords
    const { keywords, keyword_list_id } = await req.json()
    let finalKeywords: string[] = []

    if (keyword_list_id) {
      const { data: listData, error: listError } = await supabaseClient
        .from('keyword_lists')
        .select('keywords, user_id')
        .eq('id', keyword_list_id)
        .single()
      
      // Crucially, verify ownership of the list
      if (listError || !listData || listData.user_id !== user.id) {
        throw new Error('Keyword list not found or access denied.')
      }
      finalKeywords = listData.keywords
    } else if (keywords && Array.isArray(keywords)) {
      finalKeywords = keywords
    } else {
      throw new Error('Keywords must be provided either as an array or via a keyword_list_id.')
    }

    // 4. Decrement Credits
    const { error: creditError } = await supabaseClient
      .rpc('decrement_credits', { user_id_param: user.id, amount: 1 })

    if (creditError) {
      throw new Error('Failed to decrement credits.')
    }
    
    // 5. Process CVs (Placeholder Logic)
    // In a real application, you would add your Gemini API calls here
    // using the `finalKeywords` array.
    
    return new Response(JSON.stringify({ message: `Successfully processed CVs using keywords: ${finalKeywords.join(', ')}` }), {
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
