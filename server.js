const express    = require("express");
const cors       = require("cors");
const mongoose   = require("mongoose");
const crypto     = require("crypto");
const QRCode     = require("qrcode");
const PDFDocument= require("pdfkit");
const fs         = require("fs");
const path       = require("path");

const app = express();

/* ─────────────────────────────────────────
   MIDDLEWARE
───────────────────────────────────────── */
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* ─────────────────────────────────────────
   MONGODB
───────────────────────────────────────── */
const MONGO_URI = process.env.MONGO_URI ||
  "mongodb+srv://loufadesign_db_user:qXjO4DkOh2Za7wLE@cluster0.xfxqvtg.mongodb.net/yeksina";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connecté"))
  .catch(err => console.error("❌ MongoDB :", err.message));

/* ─────────────────────────────────────────
   PLACES + DATES
───────────────────────────────────────── */
let placesDisponibles = {
  Dakar:   14,
  Touba:   14,
  Kaolack: 14,
};

const datesDisponibles = ["2026-05-22", "2026-05-23", "2026-05-24"];

/* ─────────────────────────────────────────
   MODEL
───────────────────────────────────────── */
const reservationSchema = new mongoose.Schema({
  nom:        { type: String, required: true },
  telephone:  { type: String, required: true },
  trajet:     { type: String, required: true, enum: ["Dakar","Touba","Kaolack"] },
  places:     { type: Number, required: true },
  dateVoyage: { type: String, required: true }, // ✔️ AJOUT
  siege:      { type: String },
  prix:       { type: Number, required: true },
  statut:     { type: String, default: "EN_ATTENTE_PAIEMENT" },
  codeTicket: { type: String, unique: true },
  qrCode:     { type: String },
  pdf:        { type: String },
  date:       { type: Date, default: Date.now },
});

const Reservation = mongoose.model("Reservation", reservationSchema);

/* ─────────────────────────────────────────
   HELPERS
───────────────────────────────────────── */

function normalizeTel(v){
  return String(v).replace(/\D/g,"");
}

function isTel(v){
  const clean = normalizeTel(v);
  return clean.length >= 9 && clean.length <= 15;
}

function isNom(v){
  return typeof v === "string" &&
    /^[a-zA-ZÀ-ÿ\s\-']+$/.test(v.trim()) &&
    v.trim().length >= 2;
}

/* ✔️ PRIX FIX KAOLACK */
function getPrix(trajet){
  return {
    Dakar: 4000,
    Touba: 5000,
    Kaolack: 6550
  }[trajet] || 5000;
}

function genererSiege(restantes){
  const lettres = ["A","B","C","D"];
  return lettres[Math.floor(Math.random()*lettres.length)] + restantes;
}

function genererCodeTicket(){
  return "YKS-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

/* ─────────────────────────────────────────
   PDF
───────────────────────────────────────── */
const PDF_DIR = path.join(__dirname,"pdfs");
if(!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR);

async function genererPDF(reservation){
  const { codeTicket, nom, telephone, trajet, places, siege, prix } = reservation;

  const pdfPath = path.join(PDF_DIR, codeTicket+".pdf");

  return new Promise((resolve,reject)=>{
    const doc = new PDFDocument({ size:"A5", margins:50 });
    const stream = fs.createWriteStream(pdfPath);

    doc.pipe(stream);

    doc.fontSize(20).text("YEKSINA VOYAGE",{align:"center"});
    doc.moveDown();

    doc.fontSize(12).text(`Ticket: ${codeTicket}`);
    doc.moveDown();

    const details = [
      ["Nom", nom],
      ["Téléphone", telephone],
      ["Trajet", `UGB → ${trajet}`],
      ["Places", places],
      ["Siège", siege],
      ["Prix", `${prix * places} FCFA`],
    ];

    details.forEach(([a,b])=>{
      doc.text(`${a} : ${b}`);
    });

    doc.end();

    stream.on("finish", ()=>resolve(codeTicket+".pdf"));
    stream.on("error", reject);
  });
}

/* ─────────────────────────────────────────
   ROUTES
───────────────────────────────────────── */

app.get("/places",(req,res)=>{
  res.json(placesDisponibles);
});

/* ✔️ RESERVATION FINAL */
app.post("/reserver", async (req,res)=>{
  try{
    let { nom, telephone, trajet, places, date } = req.body;

    if(!nom || !telephone || !trajet || !places || !date){
      return res.json({success:false,message:"Champs manquants"});
    }

    if(!datesDisponibles.includes(date)){
      return res.json({success:false,message:"Date invalide"});
    }

    if(!isNom(nom)){
      return res.json({success:false,message:"Nom invalide"});
    }

    if(!isTel(telephone)){
      return res.json({success:false,message:"Téléphone invalide"});
    }

    const nbPlaces = parseInt(places);

    if(nbPlaces > placesDisponibles[trajet]){
      return res.json({success:false,message:"Pas assez de places"});
    }

    placesDisponibles[trajet] -= nbPlaces;

    const prix = getPrix(trajet);
    const codeTicket = genererCodeTicket();
    const siege = genererSiege(placesDisponibles[trajet]);

    const reservation = new Reservation({
      nom: nom.trim(),
      telephone: normalizeTel(telephone),
      trajet,
      places: nbPlaces,
      dateVoyage: date,
      siege,
      prix,
      codeTicket
    });

    await reservation.save();

    genererPDF({
      codeTicket,
      nom,
      telephone,
      trajet,
      places: nbPlaces,
      siege,
      prix
    }).then(pdf => reservation.pdf = pdf);

    const paymentUrl =
      `https://pay.wave.com/m/M_sn_O2mWfULdH641/c/sn/?amount=${prix * nbPlaces}`;

    return res.json({
      success:true,
      ticketCode: codeTicket,
      prix,
      siege,
      restantes: placesDisponibles[trajet],
      paymentUrl
    });

  }catch(err){
    console.error(err);
    return res.json({success:false,message:"Erreur serveur"});
  }
});

/* ─────────────────────────────────────────
   START
───────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>{
  console.log("🚀 Serveur OK :", PORT);
});