import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Restaurant AI Voice Agent - Server Running on Render");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server listening on port", port);
});

import twilio from "twilio";

// Twilio Voice Webhook
app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const connect = twiml.connect();
  connect.stream({
    url: "wss://restaurant-voice-agent-v2.onrender.com/twilio-media-stream"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});


