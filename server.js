import OpenAI from "openai";
import 'dotenv/config';
import express from 'express';
import ExpressWs from 'express-ws';
import crypto from 'crypto';
import twilio from 'twilio';
const accountSid = process.env.TWILIO_ACCOUNT_SID_MESSAGING;
const authToken = process.env.TWILIO_AUTH_TOKEN_MESSAGING;
const client = twilio(accountSid, authToken);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
ExpressWs(app);


///// Flags////
let stage = "dev" // "prod"
///////////////

const PORT = process.env.PORT || 3001;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const connections = new Map();

////// Firebase Stuff /////
import { ref, get } from "firebase/database";
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
  const salt = 'apples_are_not_yellow';
  const saltedPhoneNumber = number + salt;
  return crypto.createHash('sha256').update(saltedPhoneNumber).digest('hex');
}

app.ws('/connection', (ws) => {
  try {

    ws.on('message', async data => { // Incoming message from CR
      const msg = JSON.parse(data);
      console.log("Incoming orcestration: ", msg);
      if(msg.from){
        connections.set(ws, msg.from)
      }

      if (msg.type === "setup") {
        if (stage !== "dev") {
          // Find the threadID from firebase
          const phoneNumber = msg.from.slice(2, msg.from.length) // remove the country code (+1)
          let userId = hashPhoneNumber(phoneNumber);

          // Preform query in firebase
          let data;
          try {
            const userRef = ref(db, `users/${userId}/profile`);
            const result = await get(userRef)
            data = result.val();
          } catch (err) {
            console.error("Issue pulling user data from firebase: ", err)
          }

          console.log("here's the data: ", data)
        }

        // Conversation logic
        if (data) {
          if (stage === "dev") {
            ws.threadId = "thread_VNrKk7lFTb68NMjznZa4lrzs"
            ws.assistantId = "asst_9mFIvkOJwIBAUfeMoQjmQ4rG"
          } else {
            ws.threadId = data.thread.id;
            ws.assistantId = data.assistantId;
          }

          // Pretend the user starts the conversation
          await openai.beta.threads.messages.create(ws.threadId, {
            role: "user",
            content: "Hi there!"
          });


          const run = openai.beta.threads.runs.stream(ws.threadId, {
            assistant_id: ws.assistantId
          });

          run.on('textDone', async (textDone, snapshot) => {
            // Send response from OpenAI model to Conversation Relay to be read back to the caller
            console.log("textdone: ", textDone)

            ws.send(
              JSON.stringify({
                type: "text",
                token: textDone.value
              })
            )
            // console.log("after")
          })
        }
      } else if (msg.type === "prompt") { // A user begins speaking
        // Make sure a thread isn't running

        if (ws.runInProgress) {
          console.warn("Run already in progress; ignoring new prompt");
          return;
        }
        ws.runInProgress = true; // run flag MUST BE AFTER THE CHECK

        try { // if nothing's running
          // Add message to the thread
          await openai.beta.threads.messages.create(ws.threadId, {
            role: "user",
            content: msg.voicePrompt
          });

          // run the thread
          const run = openai.beta.threads.runs.stream(ws.threadId, {
            assistant_id: ws.assistantId
          });

          run.on('textDone', (textDone) => {
            ws.send(JSON.stringify({
              type: "text",
              token: textDone.value
            }));
            console.log("textDone: ", textDone);
          });

          run.on('runStepDone', () => {
            ws.runInProgress = false; // Clear run flag when done
          });

        } catch (err) {
          ws.runInProgress = false;
          console.error("Run failed:", err);
        }
      }
    })
    ws.on("close", async () => {
      const caller = connections.get(ws);
      console.log("here's the caller data: ", caller)
      ////////////////// Send Text Message ////////////////////
      try {
        await client.messages.create({
          from: process.env.FROM_NUMBER,
          to: caller,
          body: `Dear creator, feel free to call me back anytime!\n(415)704-6756`
        }).then(s => {
          console.log('message sent');
        });
      } catch (error) {
        console.error('ERROR!!!!!!!', error);
      }
      //////////////////////////////////////////////////////////
      connections.delete(ws)
      console.log("WebSocket connection closed");
    });

  } catch (err) {
    console.error("ERROR: ", err);
  }
});




app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});