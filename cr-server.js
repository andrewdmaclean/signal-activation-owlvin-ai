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
import serviceAccount from "./service-account-key.json" assert {type: "json"}; // local
// import serviceAccount from "/etc/secrets/service-account-key.json" with { type: "json" }; // deployment

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL // database URL
});

const db = admin.database(); // Get a database reference

function hashPhoneNumber(number) {
  const salt = 'apples_are_not_yellow'; // Generate or store a unique salt
  const saltedPhoneNumber = number + salt;
  return crypto.createHash('sha256').update(saltedPhoneNumber).digest('hex');
}

app.post('/voice', async (req, res) => {
  const response = new VoiceResponse();
  const connect = response.connect();
  const caller = req.body.From
  console.log("caller: ", caller)
  const userId = hashPhoneNumber(caller)

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
  let voiceId = data.voiceId;
  console.log("here's the data: ", data)

  connect.conversationRelay({
    url: /*"wss://owlvin-ai-server-js-692351747341.us-west1.run.app/connection", //deployed >*/ "wss://6bd61a7d7052.ngrok.app/connection", // dev
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
  let voiceId;
  switch (tone) {
    case "Technical":
      voiceId = "6xPz2opT0y5qtoRh1U1Y" // 905ms Middle aged American male voice. Good for clear narration. 
      break;
    case "Casual":
      voiceId = "pPdl9cQBQq4p6mRkZy2Z"  // 948ms An adorable voice perfect for animation projects.
      break;
    case "Ironic":
      voiceId = "9yzdeviXkFddZ4Oz8Mok" // n/a Young American male voice cheerfully cracking up. Perfect for humorous dialogues and happy characters. Voice was created reading jokes and funny literature.
      break;
    default: // Sarcastic
      voiceId = "mZ8K1MPRiT5wDQaasg3i" // 897ms A British studio quality voice with a neutral, warm English accent, great for TV, Voiceover, Explainer videos, Advertising and Social Media.
  }
  console.log("the voiceId selected: ", voiceId)

  const dbRef = ref(db);
  const path = `users/${userId}/profile/`
  const profileDetails = {
    personality,
    topic,
    lastUsed: serverTimestamp(),
    active: true,
    voiceId
  }

  try {
    await update(dbRef, {
      [path]: profileDetails
    })
    console.log("profile created in firebase")
  } catch (err) {
    console.error("Issue creating profile in firebase")
  }

  res.send(200, "good")
});


app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});