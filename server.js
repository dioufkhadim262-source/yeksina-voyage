const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const crypto = require("crypto");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const app = express();

/* =========================
   CONFIG
========================= */
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/* =========================
   MONGODB
========================= */
mongoose.connect(
"mongodb+srv://loufadesign_db_user:qXjO4DkOh2Za7wLE@cluster0.xfxqvtg.mongodb.net/yeksina"
)
.then(()=>console.log("✅ MongoDB connecté"))
.catch(err=>console.log("❌ MongoDB :",err));

/* =========================
   PLACES DISPONIBLES
========================= */
let placesDisponibles = {

  Dakar:14,

  Touba:14,

  Kaolack:14

};

/* =========================
   MODELE
========================= */
const Reservation = mongoose.model("Reservation",{

  nom:String,

  telephone:String,

  trajet:String,

  places:Number,

  siege:String,

  prix:Number,

  statut:{
    type:String,
    default:"EN_ATTENTE_PAIEMENT"
  },

  codeTicket:String,

  qrCode:String,

  pdf:String,

  date:{
    type:Date,
    default:Date.now
  }

});

/* =========================
   VALIDATION
========================= */
function isNom(v){

  return /^[a-zA-ZÀ-ÿ\s]+$/.test(v);

}

function isTel(v){

  return /^[0-9]+$/.test(v);

}

/* =========================
   GENERER SIEGE
========================= */
function genererSiege(restantes){

  const lettres = ["A","B","C","D"];

  const lettre =
  lettres[Math.floor(Math.random()*lettres.length)];

  return lettre + restantes;

}

/* =========================
   PRIX
========================= */
function getPrix(trajet){

  if(trajet==="Dakar") return 4000;

  if(trajet==="Touba") return 5000;

  if(trajet==="Kaolack") return 6500;

  return 5000;

}

/* =========================
   API PLACES
========================= */
app.get("/places",(req,res)=>{

  res.json(placesDisponibles);

});

/* =========================
   RESERVER
========================= */
app.post("/reserver", async (req,res)=>{

  try{

    const {

      nom,
      telephone,
      trajet,
      places

    } = req.body;

    /* VALIDATION */
    if(!nom || !telephone || !trajet || !places){

      return res.json({

        success:false,

        message:"Champs manquants"

      });

    }

    if(!isNom(nom)){

      return res.json({

        success:false,

        message:
        "Nom invalide"

      });

    }

    if(!isTel(telephone)){

      return res.json({

        success:false,

        message:
        "Téléphone invalide"

      });

    }

    const nbPlaces =
    parseInt(places);

    if(nbPlaces <= 0){

      return res.json({

        success:false,

        message:"Nombre invalide"

      });

    }

    /* VERIFICATION PLACES */
    if(nbPlaces > placesDisponibles[trajet]){

      return res.json({

        success:false,

        message:
        "❌ Plus assez de places disponibles"

      });

    }

    /* DIMINUER PLACES */
    placesDisponibles[trajet] -= nbPlaces;

    /* PRIX */
    const prix = getPrix(trajet);

    /* CODE TICKET */
    const codeTicket =
    "YKS-"+
    crypto.randomBytes(4)
    .toString("hex")
    .toUpperCase();

    /* SIEGE */
    const siege =
    genererSiege(
      placesDisponibles[trajet]
    );

    /* QR CODE */
    const qrData =
    `
    Ticket:${codeTicket}
    Nom:${nom}
    Trajet:${trajet}
    Places:${nbPlaces}
    `;

    const qrCode =
    await QRCode.toDataURL(qrData);

    /* PDF */
    const pdfName =
    codeTicket + ".pdf";

    const pdfPath =
    path.join(__dirname,pdfName);

    const doc =
    new PDFDocument();

    doc.pipe(
      fs.createWriteStream(pdfPath)
    );

    doc.fontSize(25)
    .text(
      "YEKSINA VOYAGE",
      {
        align:"center"
      }
    );

    doc.moveDown();

    doc.fontSize(18)
    .text("TICKET PREMIUM");

    doc.moveDown();

    doc.text("Nom : "+nom);

    doc.text("Téléphone : "+telephone);

    doc.text("Trajet : "+trajet);

    doc.text("Places : "+nbPlaces);

    doc.text("Siège : "+siege);

    doc.text("Prix : "+prix+" FCFA");

    doc.text("Code : "+codeTicket);

    doc.text("Statut : EN ATTENTE PAIEMENT");

    doc.end();

    /* SAVE */
    const reservation =
    new Reservation({

      nom,

      telephone,

      trajet,

      places:nbPlaces,

      siege,

      prix,

      codeTicket,

      qrCode,

      pdf:pdfName

    });

    await reservation.save();

    console.log(
      "🟢 Réservation :",
      reservation
    );

    /* RESPONSE */
    res.json({

      success:true,

      reservationId:
      reservation._id,

      ticketCode:
      codeTicket,

      prix,

      siege,

      qrCode,

      pdf:
      pdfName,

      restantes:
      placesDisponibles[trajet],

      statut:
      reservation.statut,

      paymentUrl:
      `https://pay.wave.com/m/M_sn_O2mWfULdH641/c/sn/?amount=${prix}`

    });

  }

  catch(err){

    console.log(err);

    res.json({

      success:false,

      message:
      "Erreur serveur"

    });

  }

});

/* =========================
   CONFIRMATION PAIEMENT
========================= */
app.get("/payer/:ticket", async (req,res)=>{

  try{

    const reservation =
    await Reservation.findOne({

      codeTicket:
      req.params.ticket

    });

    if(!reservation){

      return res.send(
        "Ticket introuvable"
      );

    }

    reservation.statut =
    "PAYE";

    await reservation.save();

    res.send(`
      <h1>
      ✅ Paiement confirmé
      </h1>

      <h2>
      Ticket :
      ${reservation.codeTicket}
      </h2>

      <a href="/${reservation.pdf}">
      Télécharger PDF
      </a>
    `);

  }

  catch(err){

    console.log(err);

    res.send(
      "Erreur"
    );

  }

});

/* =========================
   ADMIN
========================= */
app.get("/admin", async (req,res)=>{

  const reservations =
  await Reservation.find()
  .sort({date:-1});

  let html = `

  <html>

  <head>

  <title>
  ADMIN YEKSINA
  </title>

  <style>

  body{

    font-family:Arial;

    background:#f4f4f4;

    padding:20px;

  }

  .card{

    background:white;

    padding:20px;

    border-radius:15px;

    margin-bottom:20px;

    box-shadow:
    0 5px 15px rgba(0,0,0,0.1);

  }

  h1{

    color:#0d47a1;

  }

  </style>

  </head>

  <body>

  <h1>
  ADMIN YEKSINA VOYAGE
  </h1>

  <h3>
  Dakar :
  ${placesDisponibles.Dakar}
  places restantes
  </h3>

  <h3>
  Touba :
  ${placesDisponibles.Touba}
  places restantes
  </h3>

  <h3>
  Kaolack :
  ${placesDisponibles.Kaolack}
  places restantes
  </h3>

  <hr>

  `;

  reservations.forEach(r=>{

    html += `

    <div class="card">

      <b>Nom :</b>
      ${r.nom}<br><br>

      <b>Téléphone :</b>
      ${r.telephone}<br><br>

      <b>Trajet :</b>
      ${r.trajet}<br><br>

      <b>Places :</b>
      ${r.places}<br><br>

      <b>Siège :</b>
      ${r.siege}<br><br>

      <b>Prix :</b>
      ${r.prix} FCFA<br><br>

      <b>Ticket :</b>
      ${r.codeTicket}<br><br>

      <b>Statut :</b>
      ${r.statut}<br><br>

      <a href="/${r.pdf}">
      Télécharger Ticket PDF
      </a>

    </div>

    `;

  });

  html += `
  </body>
  </html>
  `;

  res.send(html);

});

/* =========================
   SERVER
========================= */
app.listen(3000,()=>{

  console.log(
  "🚀 Serveur lancé sur http://localhost:3000"
  );

});