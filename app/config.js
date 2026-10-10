// Copy app/env.example to app/.env, then restart Expo. These values are bundled
// into the phone app: never put server tokens, API keys, or other secrets here.
export const config = {
  serverUrl: process.env.EXPO_PUBLIC_ECHO_SERVER_URL || '',
  momNumber: process.env.EXPO_PUBLIC_ECHO_MOM_NUMBER || '',
  demoCalls: process.env.EXPO_PUBLIC_ECHO_DEMO_CALLS === 'true',
  demoNumber: process.env.EXPO_PUBLIC_ECHO_DEMO_NUMBER || '',
};
