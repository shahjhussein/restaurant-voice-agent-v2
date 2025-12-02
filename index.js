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

// ...

app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Hello! Your Syntropy AI reservation system is connected successfully.");
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

