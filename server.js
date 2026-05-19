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
app.use(express.static(path.join(__dirname, "public")));   // Serves index.html + static assets

/* ─────────────────────────────────────────
   MONGODB CONNECTION
───────────────────────────────────────── */
const MONGO_URI = process.env.MONGO_URI ||
  "mongodb+srv://loufadesign_db_user:qXjO4DkOh2Za7wLE@cluster0.xfxqvtg.mongodb.net/yeksina";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅  MongoDB connecté"))
  .catch(err => {
    console.error("❌  MongoDB :", err.message);
    // Server still starts; reservations will fail gracefully
  });

/* ─────────────────────────────────────────
   PLACES DISPONIBLES (in-memory)
   NOTE: In production, store this in MongoDB
   so the count survives server restarts.
───────────────────────────────────────── */
let placesDisponibles = {
  Dakar:   14,
  Touba:   14,
  Kaolack: 14,
};

/* ─────────────────────────────────────────
   MONGOOSE MODEL
───────────────────────────────────────── */
const reservationSchema = new mongoose.Schema({
  nom:        { type: String, required: true },
  telephone:  { type: String, required: true },
  trajet:     { type: String, required: true, enum: ["Dakar","Touba","Kaolack"] },
  places:     { type: Number, required: true, min: 1 },
  siege:      { type: String },
  prix:       { type: Number, required: true },
  statut:     { type: String, default: "EN_ATTENTE_PAIEMENT",
                enum: ["EN_ATTENTE_PAIEMENT","PAYE","ANNULE"] },
  codeTicket: { type: String, unique: true },
  qrCode:     { type: String },
  pdf:        { type: String },
  date:       { type: Date, default: Date.now },
});

const Reservation = mongoose.model("Reservation", reservationSchema);

/* ─────────────────────────────────────────
   HELPERS
───────────────────────────────────────── */

/** Valide un nom : lettres, espaces, tirets, apostrophes */
function isNom(v) {
  return typeof v === "string" && /^[a-zA-ZÀ-ÿ\s\-']+$/.test(v.trim()) && v.trim().length >= 2;
}

/** Valide un numéro de téléphone : chiffres uniquement, 7-15 caractères */
function isTel(v) {
  return typeof v === "string" && /^[0-9]{7,15}$/.test(v.trim());
}

/** Génère un code de siège aléatoire */
function genererSiege(restantes) {
  const lettres = ["A", "B", "C", "D"];
  const lettre  = lettres[Math.floor(Math.random() * lettres.length)];
  return lettre + restantes;
}

/** Prix par trajet */
function getPrix(trajet) {
  const tarifs = { Dakar: 4000, Touba: 5000, Kaolack: 6000 };
  return tarifs[trajet] || 5000;
}

/** Génère un code ticket unique */
function genererCodeTicket() {
  return "YKS-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

/** S'assure que le dossier PDFs existe */
const PDF_DIR = path.join(__dirname, "pdfs");
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR);

/** Génère un PDF et retourne le chemin relatif */
async function genererPDF(reservation) {
  const { codeTicket, nom, telephone, trajet, places, siege, prix } = reservation;
  const pdfName = codeTicket + ".pdf";
  const pdfPath = path.join(PDF_DIR, pdfName);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A5", margins: { top:50, left:50, right:50, bottom:50 } });
    const stream = fs.createWriteStream(pdfPath);

    doc.pipe(stream);

    // ─ En-tête
    doc.fontSize(22).font("Helvetica-Bold")
       .fillColor("#0B1F4E").text("YEKSINA VOYAGE", { align: "center" });

    doc.moveDown(0.3);
    doc.fontSize(10).font("Helvetica")
       .fillColor("#6B6B69").text("Transport Longue Distance — Saint-Louis", { align: "center" });

    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor("#E0E0DF").stroke();

    // ─ Titre ticket
    doc.moveDown(0.5);
    doc.fontSize(14).font("Helvetica-Bold").fillColor("#FF6B00")
       .text("TICKET DE VOYAGE", { align: "center" });

    doc.moveDown(0.4);
    doc.fontSize(11).font("Helvetica")
       .fillColor("#0B1F4E").text(`Code : ${codeTicket}`, { align: "center" });

    // ─ Détails
    doc.moveDown(1);
    const details = [
      ["Passager",   nom],
      ["Téléphone",  telephone],
      ["Trajet",     `UGB → ${trajet}`],
      ["Départ",     "04h45"],
      ["Nb places",  String(places)],
      ["Siège",      siege],
      ["Prix total", `${(prix * places).toLocaleString("fr-FR")} FCFA`],
      ["Statut",     "EN ATTENTE DE PAIEMENT"],
    ];

    details.forEach(([label, value]) => {
      doc.fontSize(10).font("Helvetica-Bold").fillColor("#6B6B69").text(label + " :", { continued: true });
      doc.font("Helvetica").fillColor("#111111").text("  " + value);
      doc.moveDown(0.2);
    });

    // ─ Footer
    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor("#E0E0DF").stroke();
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor("#6B6B69")
       .text("📞 WhatsApp : +221 78 612 76 44 | +221 78 821 31 67", { align: "center" });
    doc.text("© 2026 Yeksina Voyage — Tous droits réservés", { align: "center" });

    doc.end();

    stream.on("finish", () => resolve(pdfName));
    stream.on("error",  reject);
  });
}

/* ─────────────────────────────────────────
   ROUTES
───────────────────────────────────────── */

/** GET /places — nombre de places disponibles par trajet */
app.get("/places", (req, res) => {
  res.json(placesDisponibles);
});

/** POST /reserver — créer une réservation */
app.post("/reserver", async (req, res) => {
  try {
    const { nom, telephone, trajet, places } = req.body;

    // ── Validation des champs requis
    if (!nom || !telephone || !trajet || !places) {
      return res.json({ success: false, message: "Tous les champs sont obligatoires." });
    }

    if (!isNom(nom)) {
      return res.json({ success: false, message: "Nom invalide — lettres uniquement." });
    }

    if (!isTel(telephone)) {
      return res.json({ success: false, message: "Numéro de téléphone invalide." });
    }

    if (!["Dakar","Touba","Kaolack"].includes(trajet)) {
      return res.json({ success: false, message: "Trajet inconnu." });
    }

    const nbPlaces = parseInt(places, 10);
    if (isNaN(nbPlaces) || nbPlaces < 1 || nbPlaces > 10) {
      return res.json({ success: false, message: "Nombre de places invalide." });
    }

    // ── Vérifier disponibilité
    if (nbPlaces > placesDisponibles[trajet]) {
      return res.json({
        success: false,
        message: `❌ Il ne reste que ${placesDisponibles[trajet]} place(s) disponible(s) pour ${trajet}.`
      });
    }

    // ── Réserver les places (atomique dans ce contexte single-thread)
    placesDisponibles[trajet] -= nbPlaces;

    const prix       = getPrix(trajet);
    const codeTicket = genererCodeTicket();
    const siege      = genererSiege(placesDisponibles[trajet]);

    // ── QR Code
    const qrData = `YEKSINA|${codeTicket}|${nom.trim()}|${trajet}|${nbPlaces}`;
    const qrCode = await QRCode.toDataURL(qrData);

    // ── Sauvegarde en DB (avant PDF pour avoir l'ID)
    const reservation = new Reservation({
      nom:        nom.trim(),
      telephone:  telephone.trim(),
      trajet,
      places:     nbPlaces,
      siege,
      prix,
      codeTicket,
      qrCode,
    });
    await reservation.save();

    // ── Générer PDF (non bloquant pour la réponse)
    genererPDF({ codeTicket, nom: nom.trim(), telephone: telephone.trim(), trajet, places: nbPlaces, siege, prix })
      .then(async pdfName => {
        reservation.pdf = pdfName;
        await reservation.save();
      })
      .catch(err => console.error("PDF error:", err.message));

    // ── Réponse
    const paymentUrl = `https://pay.wave.com/m/M_sn_O2mWfULdH641/c/sn/?amount=${prix * nbPlaces}`;

    console.log(`🟢 Réservation ${codeTicket} | ${nom.trim()} | ${trajet} | ${nbPlaces} place(s)`);

    return res.json({
      success:       true,
      reservationId: reservation._id,
      ticketCode:    codeTicket,
      prix,
      siege,
      qrCode,
      restantes:     placesDisponibles[trajet],
      statut:        reservation.statut,
      paymentUrl,
    });

  } catch (err) {
    console.error("Erreur /reserver :", err.message);
    return res.json({ success: false, message: "Erreur serveur. Réessayez dans un instant." });
  }
});

/** GET /pdfs/:filename — télécharger un PDF de ticket */
app.get("/pdfs/:filename", (req, res) => {
  const filename = path.basename(req.params.filename); // Prevent path traversal
  const filePath = path.join(PDF_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Fichier introuvable.");
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  fs.createReadStream(filePath).pipe(res);
});

/** GET /payer/:ticket — confirmer paiement (webhook simplifié) */
app.get("/payer/:ticket", async (req, res) => {
  try {
    const reservation = await Reservation.findOne({ codeTicket: req.params.ticket });

    if (!reservation) {
      return res.status(404).send("Ticket introuvable.");
    }

    reservation.statut = "PAYE";
    await reservation.save();

    res.send(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Paiement confirmé — Yeksina Voyage</title>
        <style>
          body { font-family: Arial, sans-serif; background:#F5F3EE; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
          .box { background:white; border-radius:20px; padding:40px; max-width:420px; text-align:center; box-shadow:0 20px 60px rgba(0,0,0,0.12); }
          h1 { color:#1D9E75; margin:0 0 10px; font-size:28px; }
          p  { color:#6B6B69; line-height:1.6; }
          .code { font-size:18px; font-weight:700; color:#0B1F4E; background:#E8EDF8; padding:10px 20px; border-radius:10px; margin:16px 0; display:inline-block; }
          a  { display:inline-block; margin-top:16px; padding:12px 28px; background:#0B1F4E; color:white; border-radius:10px; text-decoration:none; font-weight:700; }
          a:hover { background:#1A3575; }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>✅ Paiement confirmé !</h1>
          <p>Votre réservation est validée. Bonne route !</p>
          <div class="code">${reservation.codeTicket}</div>
          <p><strong>Trajet :</strong> UGB → ${reservation.trajet}<br>
             <strong>Siège :</strong> ${reservation.siege}<br>
             <strong>Départ :</strong> 04h45</p>
          ${reservation.pdf ? `<a href="/pdfs/${reservation.pdf}">⬇ Télécharger le ticket PDF</a>` : ""}
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("Erreur /payer :", err.message);
    res.status(500).send("Erreur serveur.");
  }
});

/** GET /admin — tableau de bord (protéger avec auth en production) */
app.get("/admin", async (req, res) => {
  try {
    const reservations = await Reservation.find().sort({ date: -1 });

    const totaux = { Dakar: 0, Touba: 0, Kaolack: 0 };
    let totalRecettes = 0;
    reservations.forEach(r => {
      if (totaux[r.trajet] !== undefined) totaux[r.trajet] += r.places;
      if (r.statut === "PAYE") totalRecettes += r.prix * r.places;
    });

    const badge = s => {
      const colors = {
        PAYE: "background:#E8F7F3;color:#1D9E75",
        EN_ATTENTE_PAIEMENT: "background:#FFF3E8;color:#FF6B00",
        ANNULE: "background:#FEF0F0;color:#E24B4A",
      };
      return `<span style="${colors[s]||''};padding:3px 10px;border-radius:100px;font-size:12px;font-weight:700;">${s.replace(/_/g," ")}</span>`;
    };

    const rows = reservations.map(r => `
      <tr>
        <td>${new Date(r.date).toLocaleString("fr-FR")}</td>
        <td>${r.nom}</td>
        <td>${r.telephone}</td>
        <td>UGB → ${r.trajet}</td>
        <td>${r.places}</td>
        <td>${r.siege}</td>
        <td>${(r.prix * r.places).toLocaleString("fr-FR")} FCFA</td>
        <td>${badge(r.statut)}</td>
        <td><code style="font-size:12px">${r.codeTicket}</code></td>
        <td>${r.pdf ? `<a href="/pdfs/${r.pdf}" style="color:#FF6B00;font-weight:700;">PDF</a>` : "—"}</td>
      </tr>
    `).join("");

    res.send(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Admin — Yeksina Voyage</title>
        <style>
          *{box-sizing:border-box;margin:0;padding:0}
          body{font-family:Arial,sans-serif;background:#F5F3EE;padding:24px}
          h1{font-size:24px;color:#0B1F4E;margin-bottom:6px}
          .subtitle{color:#6B6B69;font-size:14px;margin-bottom:24px}
          .stats{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:28px}
          .stat{background:white;padding:18px 24px;border-radius:14px;min-width:160px;box-shadow:0 4px 12px rgba(0,0,0,0.08)}
          .stat-label{font-size:12px;color:#6B6B69;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
          .stat-value{font-size:26px;font-weight:800;color:#0B1F4E}
          .stat-value.orange{color:#FF6B00}
          .table-wrap{background:white;border-radius:16px;overflow:auto;box-shadow:0 4px 12px rgba(0,0,0,0.08)}
          table{width:100%;border-collapse:collapse;font-size:13px}
          thead tr{background:#0B1F4E;color:white}
          th{padding:12px 14px;text-align:left;font-weight:600;white-space:nowrap}
          td{padding:11px 14px;border-bottom:1px solid #F0F0EF;vertical-align:middle}
          tr:last-child td{border-bottom:none}
          tr:hover td{background:#F9F9F9}
          .dispo{background:white;padding:16px 24px;border-radius:14px;margin-bottom:20px;box-shadow:0 4px 12px rgba(0,0,0,0.08);display:flex;gap:32px;flex-wrap:wrap}
          .dispo-item{font-size:14px;color:#6B6B69}
          .dispo-item strong{color:#0B1F4E;font-size:16px}
        </style>
      </head>
      <body>
        <h1>YEKSINA VOYAGE — Administration</h1>
        <p class="subtitle">Tableau de bord des réservations</p>

        <div class="stats">
          <div class="stat">
            <div class="stat-label">Total réservations</div>
            <div class="stat-value">${reservations.length}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Recettes confirmées</div>
            <div class="stat-value orange">${totalRecettes.toLocaleString("fr-FR")} F</div>
          </div>
          <div class="stat">
            <div class="stat-label">Vendues Dakar</div>
            <div class="stat-value">${totaux.Dakar}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Vendues Touba</div>
            <div class="stat-value">${totaux.Touba}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Vendues Kaolack</div>
            <div class="stat-value">${totaux.Kaolack}</div>
          </div>
        </div>

        <div class="dispo">
          <div class="dispo-item">Dakar : <strong>${placesDisponibles.Dakar} restantes</strong></div>
          <div class="dispo-item">Touba : <strong>${placesDisponibles.Touba} restantes</strong></div>
          <div class="dispo-item">Kaolack : <strong>${placesDisponibles.Kaolack} restantes</strong></div>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Nom</th><th>Téléphone</th><th>Trajet</th>
                <th>Places</th><th>Siège</th><th>Montant</th><th>Statut</th>
                <th>Code</th><th>PDF</th>
              </tr>
            </thead>
            <tbody>
              ${rows || '<tr><td colspan="10" style="text-align:center;color:#6B6B69;padding:32px">Aucune réservation</td></tr>'}
            </tbody>
          </table>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("Erreur /admin :", err.message);
    res.status(500).send("Erreur serveur.");
  }
});

/* ─────────────────────────────────────────
   START SERVER
───────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀  Serveur lancé → http://localhost:${PORT}`);
  console.log(`📋  Admin         → http://localhost:${PORT}/admin`);
});