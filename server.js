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
   MODEL
───────────────────────────────────────── */
const reservationSchema = new mongoose.Schema({
  nom:        { type: String, required: true },
  telephone:  { type: String, required: true },
  trajet:     { type: String, required: true, enum: ["Dakar","Touba","Kaolack"] },
  places:     { type: Number, required: true },
  dateVoyage: { type: String, required: true },
  siege:      { type: String },
  prix:       { type: Number, required: true },
  statut:     { type: String, default: "EN_ATTENTE_PAIEMENT" },
  paiement:   { type: String, default: "NON_PAYE" },
  codeTicket: { type: String, unique: true },
  date:       { type: Date, default: Date.now },
  lockExpire: { type: Date, default: null }
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

function getPrix(trajet){
  return {
    Dakar: 4000,
    Touba: 5000,
    Kaolack: 6600
  }[trajet] || 5000;
}

function genererCodeTicket(){
  return "YKS-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

/* ─────────────────────────────────────────
   🔥 ADMIN ROUTES AJOUTÉES
───────────────────────────────────────── */

/* PAGE ADMIN */
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

/* TOUTES LES RESERVATIONS */
app.get("/admin/reservations", async (req, res) => {
  try {
    const data = await Reservation.find().sort({ date: -1 });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* PAYEES SEULEMENT */
app.get("/admin/reservations/payees", async (req, res) => {
  try {
    const data = await Reservation.find({ paiement: "PAYE" }).sort({ date: -1 });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* STATISTIQUES ADMIN */
app.get("/admin/stats", async (req, res) => {
  try {
    const reservations = await Reservation.find();

    let stats = {
      totalClients: reservations.length,
      totalPlaces: 0,
      totalRevenue: 0,
      parTrajet: { Dakar: 0, Touba: 0, Kaolack: 0 }
    };

    reservations.forEach(r => {
      stats.totalPlaces += r.places;
      stats.totalRevenue += r.prix * r.places;
      stats.parTrajet[r.trajet] += r.places;
    });

    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: "Erreur stats" });
  }
});

/* VALIDATION PAIEMENT */
app.patch("/admin/valider/:id", async (req, res) => {
  try {
    await Reservation.findByIdAndUpdate(req.params.id, {
      paiement: "PAYE",
      statut: "PAYE"
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erreur validation" });
  }
});

/* ─────────────────────────────────────────
   EXPIRATION AUTO (15 MIN)
───────────────────────────────────────── */
setInterval(async () => {
  try {
    const now = new Date();

    await Reservation.deleteMany({
      paiement: "NON_PAYE",
      lockExpire: { $lt: now }
    });

  } catch (err) {
    console.error("Erreur expiration:", err.message);
  }
}, 60 * 1000);

/* ─────────────────────────────────────────
   RESERVATION
───────────────────────────────────────── */
app.post("/reserver", async (req,res)=>{
  try{
    let { nom, telephone, trajet, places, date } = req.body;

    if(!nom || !telephone || !trajet || !places || !date){
      return res.json({success:false,message:"Champs manquants"});
    }

    if(!isNom(nom) || !isTel(telephone)){
      return res.json({success:false,message:"Données invalides"});
    }

    const nbPlaces = parseInt(places);

    if(nbPlaces < 1){
      return res.json({success:false,message:"Nombre de places invalide"});
    }

    const prix = getPrix(trajet);
    const codeTicket = genererCodeTicket();

    const lockExpire = new Date(Date.now() + 15 * 60 * 1000);

    const reservation = new Reservation({
      nom: nom.trim(),
      telephone: normalizeTel(telephone),
      trajet,
      places: nbPlaces,
      dateVoyage: date,
      prix,
      codeTicket,
      paiement: "NON_PAYE",
      lockExpire
    });

    await reservation.save();

    const paymentUrl =
      `https://pay.wave.com/m/M_sn_O2mWfULdH641/c/sn/?amount=${prix * nbPlaces}`;

    return res.json({
      success:true,
      ticketCode: codeTicket,
      prix,
      paymentUrl
    });

  }catch(err){
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