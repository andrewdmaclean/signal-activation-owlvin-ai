import OpenAI from "openai";
import 'dotenv/config';
import express from 'express';
import ExpressWs from 'express-ws';
import crypto from 'crypto';
import twilio from 'twilio';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
ExpressWs(app);


///////////////

const PORT = process.env.PORT || 3001;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

////// Firebase Stuff /////
import {  ref, get } from "firebase/database";
import admin from "firebase-admin";
import serviceAccount from "./service-account-key.json" assert {type: "json"}; // local
// import serviceAccount from "/etc/secrets/service-account-key.json" with {type: "json"}; // deployment

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

      if (msg.type === "setup") {
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


        // Conversation logic
        if (data) {
          ws.threadId = data.thread.id;
          ws.assistantId = data.assistantId;

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
        // Add their question to the thread with the role "user"
        console.log(ws.threadId)
        let addMsgToThread = await openai.beta.threads.messages.create(ws.threadId, {
          role: "user",
          content: msg.voicePrompt
        });

        const run = openai.beta.threads.runs.stream(ws.threadId, {
          assistant_id: ws.assistantId
        })

        run.on('textDone', (textDone, snapshot) => {
          // Send response from OpenAI model to Conversation Relay to be read back to the caller
          ws.send(
            JSON.stringify({
              type: "text",
              token: textDone.value
            })
          )
          console.log("textDone: ", textDone)
        })
        // Continue the conversation until hangup   
      }
    })
    ws.on("close", async () => {
      // delete assistant
      // const response = await openai.beta.threads.del(thread1);// deelte the thread
      console.log("WebSocket connection closed and OpenAI thread deleted");
    });

  } catch (err) {
    console.error("ERROR: ", err);
  }
});




app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});