import OpenAI from "openai";
import 'dotenv/config';
import express from 'express';
import ExpressWs from 'express-ws';
import crypto from 'crypto';

import twilio from 'twilio';
const VoiceResponse = twilio.twiml.VoiceResponse;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
ExpressWs(app);


const PORT = process.env.PORT || 3002;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

////// Firebase Stuff /////
import { getDatabase, ref, update, serverTimestamp, get } from "firebase/database";
import admin from "firebase-admin";

const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
  universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL // database URL
});

const db = admin.database(); // Get a database reference

function extractPhoneInfo(rawNumber) {
  let isWhatsapp = false;
  let number = rawNumber;
  if (number && number.startsWith('whatsapp:')) {
    isWhatsapp = true;
    number = number.replace('whatsapp:', '');
  }
  return { number, isWhatsapp };
}

function hashPhoneNumber(number) {
  const salt = 'apples_are_not_yellow'; // Generate or store a unique salt
  const saltedPhoneNumber = number + salt;
  return crypto.createHash('sha256').update(saltedPhoneNumber).digest('hex');
}

app.post('/voice', async (req, res) => {
  const response = new VoiceResponse();
  const connect = response.connect();
  const { number: cleanNumber, isWhatsapp } = extractPhoneInfo(req.body.From);
  console.log("caller: ", cleanNumber, "isWhatsapp:", isWhatsapp);
  const userId = hashPhoneNumber(cleanNumber)

  // get the voice from firebase:
  let data;
  try {
    const userRef = ref(db, `users/${userId}/profile`);
    const result = await get(userRef)
    data = result.val();
  } catch (err) {
    console.error("Issue pulling user data from firebase: ", err)
  }

  if(!data){
    // tell caller to create a bot first
    let failResponse = new VoiceResponse();
    failResponse.say("Hm, we can't seem to find an AI agent under this phone number. Please play Owlvin and create a bot with the phone number used to make this call.");
    res.writeHead(200, {'Content-Type': 'text/xml'});
    res.end(failResponse.toString());
    return;
  }
  
  // Debug what's actually in the database
  console.log("Raw data from Firebase:", JSON.stringify(data, null, 2));
  
  let voiceId = data.voiceId;
  let locale = data.locale;
  let tone = data.tone;
  let personality = data.personality;
  
  console.log("Extracted values:", {
    voiceId,
    locale, 
    tone,
    personality
  });
  console.log("Voice selection debug:", {
    userId,
    locale,
    tone,
    voiceId,
  });
  console.log("here's the data: ", data)

  connect.conversationRelay({
    url: `wss://${process.env.WEBSOCKET_SERVER_URL}/connection`, // build from host env var
    ttsProvider: 'Elevenlabs',
    transcriptionProvider: "Deepgram",
    speechModel: "nova-3-general",
    voice: voiceId,
    interruptible: "none",
  });

  res.type('text/xml');
  res.send(response.toString());
});

app.post('/create-assistant', async (req, res) => {
  console.log("the request body from cr-service.js: ", req.body)
  let userId = hashPhoneNumber(req.body.phoneNumber);
  let topic = req.body.topic;
  let personality = req.body.personality;
  let tone = req.body.tone;
  let locale = req.body.locale;

  let voiceId;
  console.log("Voice selection inputs:", { locale, tone });
  
  if (locale === "pt") {
    // Portuguese voices
    switch (tone) {
      case "Technical":
        voiceId = "ylkAmqCrRDIZwbkOGyJe"; // Wlademir - Deep Brazilian Male
        console.log("Selected PT Technical voice:", voiceId);
        break;
      case "Casual":
        voiceId = "iScHbNW8K33gNo3lGgbo"; // Marianne
        console.log("Selected PT Casual voice:", voiceId);
        break;
      case "Ironic":
        voiceId = "l88WmPeLH7L0O0VA9lqm"; // Lax2
        console.log("Selected PT Ironic voice:", voiceId);
        break;
      default: // Sarcastic
        voiceId = "mPDAoQyGzxBSkE0OAOKw"; // Carla - Authority VSL
        console.log("Selected PT Sarcastic (default) voice:", voiceId);
    }
  } else {
    // English voices
    switch (tone) {
      case "Technical":
        voiceId = "6xPz2opT0y5qtoRh1U1Y"; // 905ms Middle aged American male voice. Good for clear narration. 
        console.log("Selected EN Technical voice:", voiceId);
        break;
      case "Casual":
        voiceId = "pPdl9cQBQq4p6mRkZy2Z";  // 948ms An adorable voice perfect for animation projects.
        console.log("Selected EN Casual voice:", voiceId);
        break;
      case "Ironic":
        voiceId = "9yzdeviXkFddZ4Oz8Mok"; // n/a Young American male voice cheerfully cracking up. Perfect for humorous dialogues and happy characters. Voice was created reading jokes and funny literature.
        console.log("Selected EN Ironic voice:", voiceId);
        break;
      default: // Sarcastic
        voiceId = "mZ8K1MPRiT5wDQaasg3i"; // 897ms A British studio quality voice with a neutral, warm English accent, great for TV, Voiceover, Explainer videos, Advertising and Social Media.
        console.log("Selected EN Sarcastic (default) voice:", voiceId);
    }
  }
  console.log("the voiceId selected: ", voiceId)

  const dbRef = ref(db);
  const path = `users/${userId}/profile/`
  const profileDetails = {
    personality,
    topic,
    lastUsed: serverTimestamp(),
    active: true,
    voiceId,
    locale,
    tone
  }
  
  console.log("Saving profile details:", JSON.stringify(profileDetails, null, 2));

  try {
    await update(dbRef, {
      [path]: profileDetails
    })
    console.log("profile created in firebase successfully")
  } catch (err) {
    console.error("Issue creating profile in firebase:", err)
  }

  res.send(200, "good")
});


app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});