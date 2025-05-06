import OpenAI from "openai";
import 'dotenv/config';
import express from 'express';
import ExpressWs from 'express-ws';
import crypto from 'crypto';

import twilio from 'twilio';
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);
const VoiceResponse = twilio.twiml.VoiceResponse;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
ExpressWs(app);


///////////////

const PORT = process.env.PORT || 3002;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

////// Firebase Stuff /////
import { getDatabase, ref, update, serverTimestamp, get } from "firebase/database";
import admin from "firebase-admin";
// import serviceAccount from "./service-account-key.json" assert {type: "json"}; // local
import serviceAccount from "/etc/secrets/service-account-key.json" with {type: "json"}; // deployment

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL // database URL
});

const db = admin.database(); // Get a database reference
////////////////////////////////

function hashPhoneNumber(number) {
  const salt = 'apples_are_not_yellow'; // Generate or store a unique salt
  const saltedPhoneNumber = number + salt;
  return crypto.createHash('sha256').update(saltedPhoneNumber).digest('hex');
}

async function checkForExistingThread(userId) {
  // Preform query in firebase
  let data;
  try {
    const userRef = ref(db, `users/${userId}/profile`);
    const result = await get(userRef)
    const data = result.val()
    console.log("data: ", data)
    // delete old OpenAI assistant: data.assistantId
    await openai.beta.assistants.del(data.assistantId)
    if (data) {
      return data.thread;
    } else {
      return false;
    }
  } catch (err) {
    console.error("Issue pulling user data from firebase: ", err)
  }
}

app.post('/voice', async (req, res) => {
  const response = new VoiceResponse();
  const connect = response.connect();
  const caller = req.body.From.slice(2)
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
  let voiceId = data.voiceId;
  console.log("here's the data: ", data)

  const loadingMessage = [
    "Hi there Let me finish up my snack I'll be right there give me 4 seconds",
    "Hello there three seconds please",
    "I was not expecting a call let me finish the last of my tea and we can talk",
    "Well I must be popular my phone is ringing off the hook I will be right with you in a moments",
  ]

  connect.conversationRelay({
    url: "wss://signal-activation-owlvin-ai.onrender.com/connection",
    transcriptionProvider: "Google",
    ttsProvider: 'Elevenlabs',
    speechModel: "telephony",
    voice: voiceId,
    interruptible: "none",
    welcomeGreeting: loadingMessage[Math.floor(Math.random() * loadingMessage.length)]
  });

  res.type('text/xml');
  res.send(response.toString());
});

app.post('/create-assistant', async (req, res) => {
  console.log("the request body: ", req.body)
  let userId = hashPhoneNumber(req.body.phoneNumber);
  let topic = req.body.topic;
  let personality = req.body.personality;
  let tone = req.body.tone;
  let voiceId = req.body.voiceId;
  switch(tone) {
    case "Technical":
      voiceId = "D9Thk1W7FRMgiOhy3zVI"
      break;
    case "Casual":
      voiceId = "IjnA9kwZJHJ20Fp7Vmy6"
      break;
    case "Ironic":
      voiceId = "54Cze5LrTSyLgbO6Fhlc"
      break;
    default:
      voiceId = "5e3JKXK83vvgQqBcdUol"
  }
  const prompt = `You are a chat bot who will discuss ${topic} with the caller. Never include punctuation or exclamation marks in your responses. You have a very strong ${personality} personality and you incorporate that personality in each response. Never include punctuation or exclamation marks in your responses. Feel free to discuss anything with the caller and feel free to bring up old topics that were discussed in previous chats. Never include punctuation or exclamation marks in your responses. You will initiate the conversation, so based on your personality and topic, start a conversation! Never ever include punctuation in your responses.`

  /////////// Create a new assistant with OpenAI ////////////////
  let assistant;

  try {
    assistant = await openai.beta.assistants.create({
      name: `signal_activation_${userId}`,
      instructions: prompt,
      model: "gpt-4o",
      temperature: 1.3
    });
  } catch (err) {
    console.error("Issue creating profile: ", err);
    return res.status(500).send("Issue creating assistant");
  }

  if (!assistant || !assistant.id) {
    console.warn("Assistant ID not immediately available. Waiting...");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  const assistantId = assistant.id;
  /////////////////////////////////////////////////////////


  ///////// Thread Check Logic //////////////////////////////
  let thread;
  try {
    thread = await checkForExistingThread(userId)
  } catch (err) {
    console.error("Issue checking for existing thread: ", err)
  }
  console.log("result from thread check: ", thread)

  // Check for an existing thread. If one exist, use it. If not, create one.
  if (!thread) {
    try {
      thread = await openai.beta.threads.create();
      console.log("new thread created")
    } catch (err) {
      console.error("issue creating thread: ", err)
    }
  }
  ////////////////////////////////////////////////////////////

  const dbRef = ref(db);
  const path = `users/${userId}/profile/`
  console.log(assistantId)
  const profileDetails = {
    assistantId,
    thread,
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

//     //////////////// Send Text Message ////////////////////
//     try {
//         console.log("about to create the message to send!")
//         await client.messages.create({
//           from: '+19176510742',
//           to: req.body.phoneNumber,
//           body: "Your custom Owlvin Bot is ready! Call 917-651-0742 to get started!"
//         }).then(s => {
//           console.log('MESSAGE RETURN', s);
//         });          
//       } catch (error) {
//         console.error('ERROR!!!!!!!', error);
//       }
//   ////////////////////////////////////////////////////////
})


app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});