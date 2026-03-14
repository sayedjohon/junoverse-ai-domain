import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://yjxhuutnjzgkwcrvnopr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqeGh1dXRuanpna3djcnZub3ByIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NDI1OTIsImV4cCI6MjA4OTAxODU5Mn0.p8s1dyoMM6ad1lW42n5YkhDPtzMjyu9DclEG7IBaGGY';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
