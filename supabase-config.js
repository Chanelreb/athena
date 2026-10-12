// Public Supabase config. The publishable key is designed to ship in the
// frontend — row-level security is what actually protects data. Safe to commit.
window.ATHENA_SUPABASE = {
  url: 'https://ubtumwzsaqcjxegklirp.supabase.co',
  publishableKey: 'sb_publishable_RO1Hl4ZETOTScUPvs0nD4w_xUdoYSLR'
};

/* ---------------------------------------------------------------------------
   The two settings a native build needs, and the web does not.

   Left unset here on purpose: unset means "behave exactly as the web always
   has", so nothing below changes anything until somebody deliberately sets
   it. They exist because these are the two things that break when Athena is
   wrapped in a native shell, and both break quietly rather than loudly.

   Where the serverless functions live.
   On the web the app and /api are the same origin, so nothing is needed. A
   native shell serves the app from capacitor://localhost or a file, where a
   root relative /api/ai is not the assistant, and often not even an error,
   just the index page arriving with a 200 on it.

     window.ATHENA_API_BASE = 'https://theathena.app';

   Where a sign-in link should land.
   Signing in leaves the app for an email and has to come back. On the web,
   back is this address. In a native shell it is a scheme the app has
   registered, and the same value has to be added to the allowed redirect
   URLs in Supabase, under Authentication, URL Configuration, or the link
   will be refused.

     window.ATHENA_AUTH_RETURN = 'athena://auth';

   And one hook rather than a setting. Connecting a calendar sends you to
   Microsoft and back. A browser simply goes; a native shell has to open a
   system browser and listen for the return, so if this function exists it is
   used instead of navigating.

     window.ATHENA_OPEN_EXTERNAL = (url) => { ... };
   --------------------------------------------------------------------------- */
