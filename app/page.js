"use client";

import { useState, useEffect, useCallback } from "react";
import { initializeApp, getApps } from "firebase/app";
import {
  getFirestore,
  collection,
  addDoc,
  query,
  orderBy,
  onSnapshot,
  doc,
  updateDoc,
  deleteDoc,
  getDocs,
  getDoc,
  setDoc,
  where,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyA2nyHbJsPUbwNyYvEz3MMkFxW7EmoqUaI",
  authDomain: "xala-hamid-skrter.firebaseapp.com",
  projectId: "xala-hamid-skrter",
  storageBucket: "xala-hamid-skrter.firebasestorage.app",
  messagingSenderId: "89920461790",
  appId: "1:89920461790:web:5ee66c174049877a21db4f",
  measurementId: "G-15DPQRL161",
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const db = getFirestore(app);

// ─── Date helpers — always dd/mm/yyyy ────────────────────────────────────────
// KEY FIX: "2024-01-15" parsed by new Date() becomes UTC midnight → wrong day
// So we parse date strings manually to avoid timezone shifting.
const parseDateSafe = (date) => {
  if (!date) return null;
  try {
    if (date && typeof date === "object" && "toDate" in date) return date.toDate();
    if (date?.seconds !== undefined) return new Date(date.seconds * 1000);
    if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      // Parse as local date to avoid UTC timezone shift
      const [y, m, d] = date.split("-").map(Number);
      return new Date(y, m - 1, d);
    }
    const d = new Date(date);
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
};

const formatDate = (date) => {
  const d = parseDateSafe(date);
  if (!d) return "N/A";
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
};

const formatDateTime = (date) => {
  const d = parseDateSafe(date);
  if (!d) return "N/A";
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
};

// ─── Image Processing ─────────────────────────────────────────────────────────
const convertToOptimizedGrayscale = (base64Image) =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const MAX = 1400;
      let { width: w, height: h } = img;
      if (w > h && w > MAX) { h = Math.round((h * MAX) / w); w = MAX; }
      else if (h > MAX) { w = Math.round((w * MAX) / h); h = MAX; }
      canvas.width = w; canvas.height = h;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);
      const id = ctx.getImageData(0, 0, w, h);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.2126 * d[i] + 0.7152 * d[i+1] + 0.0722 * d[i+2];
        let a = lum < 128 ? Math.pow(lum/128,1.2)*128 : 128+Math.pow((lum-128)/128,0.8)*128;
        a = Math.max(0, Math.min(255, (a-128)*1.1+128));
        d[i] = d[i+1] = d[i+2] = a;
      }
      ctx.putImageData(id, 0, 0);
      let res = canvas.toDataURL("image/jpeg", 0.85);
      if (Math.round((res.length*3)/4) > 800*1024) {
        const fc = document.createElement("canvas");
        const fx = fc.getContext("2d");
        fc.width = Math.round(w*0.8); fc.height = Math.round(h*0.8);
        fx.drawImage(canvas, 0, 0, fc.width, fc.height);
        res = fc.toDataURL("image/jpeg", 0.78);
      }
      resolve(res);
    };
    img.onerror = () => resolve(base64Image);
    img.src = base64Image;
  });

const pickImage = (useCamera = false) =>
  new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/*";
    if (useCamera) input.capture = "environment";
    input.style.display = "none";
    input.onchange = (e) => {
      const file = e.target.files?.[0];
      document.body.removeChild(input);
      if (!file) { reject(new Error("Cancelled")); return; }
      const reader = new FileReader();
      reader.onload = (ev) => resolve(ev.target.result);
      reader.onerror = () => reject(new Error("Read failed"));
      reader.readAsDataURL(file);
    };
    input.oncancel = () => { document.body.removeChild(input); reject(new Error("Cancelled")); };
    document.body.appendChild(input);
    input.click();
  });

// ─── Firestore image storage (base64, no Firebase Storage) ───────────────────
const IMAGES_COL = "patientImages";

const saveImage = async (patientId, base64, imageId) => {
  await setDoc(doc(db, IMAGES_COL, `${patientId}_${imageId}`), {
    patientId, imageId, base64,
    uploadedAt: new Date(),
    name: `form_${imageId}.jpg`,
  });
};

const loadImages = async (patientId) => {
  const snap = await getDocs(query(collection(db, IMAGES_COL), where("patientId","==",patientId)));
  return snap.docs.map(d => d.data()).sort((a,b) => {
    const ta = a.uploadedAt?.toDate?.()?.getTime() || 0;
    const tb = b.uploadedAt?.toDate?.()?.getTime() || 0;
    return ta - tb;
  });
};

const deleteImage = async (patientId, imageId) =>
  deleteDoc(doc(db, IMAGES_COL, `${patientId}_${imageId}`));

// ─── Generate sequential patient ID ──────────────────────────────────────────
const getNextPatientId = async () => {
  try {
    const snap = await getDocs(collection(db, "patients"));
    let max = 0;
    snap.docs.forEach(d => { const n = d.data().patientId; if (typeof n==="number" && n>max) max=n; });
    return max + 1;
  } catch { return Date.now() % 10000; }
};

// ─── Print function — FIXED: single page, no blanks, triggers printer dialog ─
const printImage = (base64, patientName, patientId) => {
  const pw = window.open("", "_blank", "width=800,height=600");
  if (!pw) { alert("Please allow popups to print"); return; }
  // Write minimal HTML — only the image, nothing else
  // Using onload on the img itself to trigger print only when image is ready
  pw.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${patientName} - Form</title>
<style>
html,body{margin:0;padding:0;width:100%;height:100%;background:#fff;}
img{width:100%;height:auto;display:block;page-break-inside:avoid;}
@media print{
  html,body{margin:0;padding:0;}
  img{max-width:100%;page-break-before:avoid;page-break-after:avoid;}
}
</style>
</head>
<body>
<img id="fi" src="${base64}" alt="form"/>
<script>
document.getElementById('fi').onload=function(){
  window.focus();
  window.print();
  setTimeout(function(){window.close();},2000);
};
document.getElementById('fi').onerror=function(){
  alert('Image failed to load');window.close();
};
</script>
</body>
</html>`);
  pw.document.close();
};

// ─── Styles ───────────────────────────────────────────────────────────────────
const C = {
  // Layout
  page:{ minHeight:"100vh", background: "linear-gradient(150deg, #00ffe1 0%, #2d85a5 40%, #90e0ef 70%, #cce7ff 100%);", padding:"24px 20px 60px", fontFamily:"'Segoe UI',system-ui,sans-serif" },
  wrap:{ maxWidth:"1280px", margin:"0 auto" },

  // Cards
  card:{ background:"#fff", borderRadius:"20px", padding:"24px", marginBottom:"20px", boxShadow:"0 4px 24px rgba(0,0,0,0.12)" },
  glassCard:{ background:"rgba(255,255,255,0.06)", backdropFilter:"blur(12px)", border:"1px solid rgba(255,255,255,0.12)", borderRadius:"20px", padding:"20px 24px", marginBottom:"20px" },

  // Header
  headerInner:{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:"12px" },
  logo:{ display:"flex", alignItems:"center", gap:"14px" },
  logoIcon:{ width:"48px", height:"48px", borderRadius:"14px", background:"linear-gradient(135deg,#3b82f6,#8b5cf6)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:"24px" },
  h1:{ fontSize:"22px", fontWeight:"800", color:"#fff", margin:0 },
  subtitle:{ fontSize:"12px", color:"rgba(255,255,255,0.5)", margin:"3px 0 0" },

  // Inputs
  input:{ width:"100%", padding:"12px 16px", border:"2px solid #e2e8f0", borderRadius:"12px", fontSize:"15px", outline:"none", boxSizing:"border-box", background:"#f8fafc", color:"#0f172a", transition:"border-color 0.2s" },
  label:{ display:"block", marginBottom:"6px", fontWeight:"600", color:"#374151", fontSize:"13px" },
  errText:{ color:"#ef4444", fontSize:"12px", marginTop:"4px" },

  // Buttons
  btnPrimary:{ background:"linear-gradient(135deg,#3b82f6,#2563eb)", color:"#fff", border:"none", padding:"11px 22px", borderRadius:"12px", fontSize:"14px", fontWeight:"700", cursor:"pointer", display:"flex", alignItems:"center", gap:"8px", boxShadow:"0 4px 14px rgba(59,130,246,0.4)", whiteSpace:"nowrap" },
  btnGreen:{ background:"linear-gradient(135deg,#10b981,#059669)", color:"#fff", border:"none", padding:"9px 16px", borderRadius:"10px", fontSize:"13px", fontWeight:"600", cursor:"pointer", display:"flex", alignItems:"center", gap:"6px" },
  btnBlue:{ background:"linear-gradient(135deg,#3b82f6,#2563eb)", color:"#fff", border:"none", padding:"9px 16px", borderRadius:"10px", fontSize:"13px", fontWeight:"600", cursor:"pointer", display:"flex", alignItems:"center", gap:"6px" },
  btnPurple:{ background:"linear-gradient(135deg,#8b5cf6,#7c3aed)", color:"#fff", border:"none", padding:"9px 16px", borderRadius:"10px", fontSize:"13px", fontWeight:"600", cursor:"pointer", display:"flex", alignItems:"center", gap:"6px" },
  btnRed:{ background:"linear-gradient(135deg,#ef4444,#dc2626)", color:"#fff", border:"none", padding:"9px 16px", borderRadius:"10px", fontSize:"13px", fontWeight:"600", cursor:"pointer", display:"flex", alignItems:"center", gap:"6px" },
  btnGray:{ background:"#f1f5f9", color:"#475569", border:"1.5px solid #e2e8f0", padding:"9px 16px", borderRadius:"10px", fontSize:"13px", fontWeight:"600", cursor:"pointer" },
  btnDisabled:{ background:"#f1f5f9", color:"#cbd5e1", border:"none", padding:"9px 16px", borderRadius:"10px", fontSize:"13px", fontWeight:"600", cursor:"not-allowed", display:"flex", alignItems:"center", gap:"6px" },

  // Overlay / Modal
  overlay:{ position:"fixed", inset:0, background:"rgba(0,0,0,0.75)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:"16px", backdropFilter:"blur(6px)" },
  modal:{ background:"#fff", borderRadius:"24px", maxWidth:"520px", width:"100%", padding:"28px", maxHeight:"92vh", overflowY:"auto", boxShadow:"0 30px 80px rgba(0,0,0,0.4)" },
  modalWide:{ background:"#fff", borderRadius:"24px", maxWidth:"680px", width:"100%", padding:"28px", maxHeight:"92vh", overflowY:"auto", boxShadow:"0 30px 80px rgba(0,0,0,0.4)" },
  closeBtn:{ background:"#f1f5f9", border:"none", borderRadius:"10px", width:"36px", height:"36px", fontSize:"16px", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", color:"#64748b", flexShrink:0 },

  // Patient card
  patientCard:{ background:"#fff", borderRadius:"18px", padding:"18px", border:"1.5px solid #f1f5f9", boxShadow:"0 2px 12px rgba(0,0,0,0.06)", transition:"all 0.22s ease" },
  idTag:{ background:"linear-gradient(135deg,#3b82f6,#8b5cf6)", color:"#fff", padding:"3px 11px", borderRadius:"20px", fontSize:"11px", fontWeight:"800", letterSpacing:"0.3px" },
  actionRow:{ display:"flex", gap:"8px", flexWrap:"wrap", marginTop:"14px" },

  // Stats bar
  statBox:{ background:"rgba(255,255,255,0.08)", border:"1px solid rgba(255,255,255,0.12)", borderRadius:"14px", padding:"14px 18px", flex:1, minWidth:"120px" },
  statNum:{ fontSize:"26px", fontWeight:"800", color:"#fff" },
  statLbl:{ fontSize:"14px", color:"rgb(255, 255, 255)", marginTop:"2px" },

  // Misc
  sectionTitle:{ fontSize:"16px", fontWeight:"700", color:"#1e293b", marginBottom:"16px", display:"flex", alignItems:"center", gap:"8px" },
  badge:{ padding:"3px 10px", borderRadius:"20px", fontSize:"12px", fontWeight:"700" },
  spinner:{ display:"inline-block", width:"44px", height:"44px", border:"4px solid #e2e8f0", borderTop:"4px solid #3b82f6", borderRadius:"50%" },
  emptyState:{ textAlign:"center", padding:"60px 20px", color:"#94a3b8" },
  thumbnailWrap:{ borderRadius:"12px", overflow:"hidden", marginTop:"12px", cursor:"pointer", position:"relative" },
  thumbnail:{ width:"100%", height:"160px", objectFit:"cover", display:"block", transition:"transform 0.2s" },
  pageGrid:{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))", gap:"18px" },

  pagination:{ display:"flex", justifyContent:"center", alignItems:"center", gap:"6px", marginTop:"28px", flexWrap:"wrap" },
  pageBtn:{ padding:"8px 14px", borderRadius:"10px", border:"1.5px solid #e2e8f0", background:"#fff", cursor:"pointer", fontSize:"13px", fontWeight:"600" },
};

// ─── Component ────────────────────────────────────────────────────────────────
export default function DoctorSecretary() {
  const [patients, setPatients]             = useState([]);
  const [loading, setLoading]               = useState(true);
  const [search, setSearch]                 = useState("");
  const [dateFrom, setDateFrom]             = useState("");
  const [dateTo, setDateTo]                 = useState("");
  const [page, setPage]                     = useState(1);
  const PER_PAGE = 9;

  const [showAdd, setShowAdd]               = useState(false);
  const [newPat, setNewPat]                 = useState({ name:"", phone:"", date: new Date().toISOString().split("T")[0] });
  const [formErr, setFormErr]               = useState({});
  const [nextId, setNextId]                 = useState(1);
  const [adding, setAdding]                 = useState(false);

  const [selPatient, setSelPatient]         = useState(null);
  const [showAttach, setShowAttach]         = useState(false);
  const [showViewer, setShowViewer]         = useState(false);
  const [showFull, setShowFull]             = useState(false);
  const [viewImgs, setViewImgs]             = useState([]);
  const [imgIdx, setImgIdx]                 = useState(0);
  const [processing, setProcessing]         = useState(false);
  const [loadingImgs, setLoadingImgs]       = useState(false);
  const [progress, setProgress]             = useState("");
  const [thumbCache, setThumbCache]         = useState({});

  useEffect(() => { getNextPatientId().then(setNextId); }, []);

  // realtime listener
  useEffect(() => {
    const q = query(collection(db,"patients"), orderBy("createdAt","desc"));
    return onSnapshot(q, async (snap) => {
      const list = snap.docs.map(d => ({
        id: d.id, ...d.data(),
        visitedDate: d.data().visitedDate?.toDate?.() || parseDateSafe(d.data().visitedDate),
        createdAt:   d.data().createdAt?.toDate?.()   || new Date(),
      }));
      setPatients(list);
      setLoading(false);
      // load thumbnails for patients with images, lazily
      list.forEach(async (p) => {
        if ((p.imageCount||0) > 0 && !thumbCache[p.id]) {
          const imgs = await loadImages(p.id);
          if (imgs[0]) setThumbCache(prev => ({ ...prev, [p.id]: imgs[0].base64 }));
        }
      });
    });
  }, []);

  // ── filter
  const filtered = patients.filter(p => {
    const s = search.toLowerCase();
    const matchS = !search || p.name?.toLowerCase().includes(s) || p.phoneNumber?.includes(search) || String(p.patientId).includes(search);
    let matchD = true;
    if (dateFrom||dateTo) {
      const pd = new Date(p.visitedDate);
      if (dateFrom) { const f=new Date(dateFrom); f.setHours(0,0,0,0); if(pd<f) matchD=false; }
      if (dateTo&&matchD) { const t=new Date(dateTo); t.setHours(23,59,59,999); if(pd>t) matchD=false; }
    }
    return matchS && matchD;
  });

  const totalPages = Math.ceil(filtered.length / PER_PAGE);
  const paginated = filtered.slice((page-1)*PER_PAGE, page*PER_PAGE);
  const stats = { total: patients.length, withForms: patients.filter(p=>(p.imageCount||0)>0).length, today: patients.filter(p=>{ const d=new Date(p.createdAt); const n=new Date(); return d.toDateString()===n.toDateString(); }).length };

  // ── add patient
  const handleAdd = async (e) => {
    e.preventDefault();
    const err = {};
    if (!newPat.name.trim()) err.name = "Name is required";
    if (!newPat.phone.trim()) err.phone = "Phone is required";
    else if (newPat.phone.replace(/\D/g,"").length < 7) err.phone = "Enter a valid number";
    if (Object.keys(err).length) { setFormErr(err); return; }
    setAdding(true);
    try {
      const pid = nextId;
      // Store visitedDate as local date string to avoid timezone issues
      const [y,m,d] = newPat.date.split("-").map(Number);
      const localDate = new Date(y, m-1, d, 12, 0, 0); // noon local = safe
      await addDoc(collection(db,"patients"), {
        patientId: pid,
        name: newPat.name.trim(),
        phoneNumber: newPat.phone.trim(),
        visitedDate: localDate,
        imageCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      setNewPat({ name:"", phone:"", date: new Date().toISOString().split("T")[0] });
      setNextId(pid+1);
      setShowAdd(false);
      setFormErr({});
    } catch(err){ alert("Failed: "+err.message); }
    finally { setAdding(false); }
  };

  // ── process & save image
  const processAndSave = useCallback(async (raw) => {
    if (!selPatient) return;
    setProcessing(true); setProgress("Converting to grayscale...");
    try {
      const gs = await convertToOptimizedGrayscale(raw);
      setProgress("Saving...");
      const imgId = Date.now().toString();
      await saveImage(selPatient.id, gs, imgId);
      const ref = doc(db,"patients",selPatient.id);
      const snap = await getDoc(ref);
      await updateDoc(ref, { imageCount:(snap.data()?.imageCount||0)+1, updatedAt:new Date() });
      setThumbCache(prev => ({ ...prev, [selPatient.id]: gs }));
      setProgress("✓ Done!");
      setTimeout(() => { setProcessing(false); setProgress(""); setShowAttach(false); }, 700);
    } catch(e) {
      alert("Save failed: "+e.message);
      setProcessing(false); setProgress("");
    }
  }, [selPatient]);

  const handleCamera = async () => {
    try { await processAndSave(await pickImage(true)); }
    catch(e) { if(e.message!=="Cancelled") alert(e.message); setProcessing(false); }
  };
  const handleFile = async () => {
    try { await processAndSave(await pickImage(false)); }
    catch(e) { if(e.message!=="Cancelled") alert(e.message); setProcessing(false); }
  };

  // ── viewer
  const openViewer = async (patient) => {
    setSelPatient(patient); setShowViewer(true); setLoadingImgs(true);
    try { setViewImgs(await loadImages(patient.id)); }
    catch(e) { alert("Load failed: "+e.message); }
    finally { setLoadingImgs(false); }
  };

  // ── delete image
  const handleDelete = async (imageId) => {
    if (!confirm("Delete this form?")) return;
    try {
      await deleteImage(selPatient.id, imageId);
      const updated = viewImgs.filter(i => i.imageId !== imageId);
      setViewImgs(updated);
      const ref = doc(db,"patients",selPatient.id);
      const snap = await getDoc(ref);
      await updateDoc(ref, { imageCount: Math.max(0,(snap.data()?.imageCount||1)-1), updatedAt:new Date() });
      if (updated.length===0) setThumbCache(prev=>({...prev,[selPatient.id]:null}));
      else if (imgIdx >= updated.length) setImgIdx(updated.length-1);
      if (showFull && updated.length===0) setShowFull(false);
    } catch(e) { alert("Delete failed: "+e.message); }
  };

  // ── render helpers
  const Spinner = ({size=44}) => (
    <div style={{...C.spinner,width:size,height:size,borderWidth:size/11}} className="spin"/>
  );

  return (
    <div style={C.page}>
      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        .spin{animation:spin .9s linear infinite}
        .pcard:hover{transform:translateY(-3px);box-shadow:0 12px 32px rgba(59,130,246,0.18)!important;border-color:#bfdbfe!important}
        .thumb:hover{transform:scale(1.03)}
        input:focus{border-color:#3b82f6!important;box-shadow:0 0 0 3px rgba(59,130,246,0.14)!important}
        button:not(:disabled):active{transform:scale(0.97)}
        .pbtn:hover:not(:disabled){filter:brightness(1.08)}
      `}</style>

      <div style={C.wrap}>

        {/* ── Header ─────────────────────────── */}
        <div style={{...C.glassCard, ...C.headerInner}}>
          <div style={C.logo}>
            <div style={C.logoIcon}>🏥</div>
            <div>
              <h1 style={C.h1}>Dr.Hameed Muhamad Salih</h1>
              <p style={C.subtitle}></p>
            </div>
          </div>
          <button className="pbtn" style={C.btnPrimary} onClick={()=>setShowAdd(true)}>
            <span style={{fontSize:"17px",lineHeight:1}}>＋</span> New Patient
          </button>
        </div>

        {/* ── Stats bar ──────────────────────── */}
        <div style={{display:"flex",gap:"12px",flexWrap:"wrap",marginBottom:"20px"}}>
          {[
{ num: stats.total,  lbl: "کۆی گشتی نەخۆش", icon: "👥" },
            {num:stats.withForms, lbl:"فایلیان هەیە", icon:"📎"},
            {num:stats.today, lbl:"نەخۆشی ئەمڕۆ", icon:"📅"},
            {num:filtered.length, lbl:"دوای گەڕان", icon:"🔍"},
          ].map(s => (
            <div key={s.lbl} style={C.statBox}>
              <div style={{fontSize:"20px",marginBottom:"4px"}}>{s.icon}</div>
              <div style={C.statNum}>{s.num}</div>
              <div style={C.statLbl}>{s.lbl}</div>
            </div>
          ))}
        </div>

        {/* ── Search card ───────────── */}
        <div style={C.card}>
          <div style={C.sectionTitle}>🔍 Search & Filter</div>
          <input style={{...C.input,marginBottom:"12px"}} placeholder="Search by name, phone, or ID..."
            value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}/>
          <div style={{display:"flex",gap:"10px",flexWrap:"wrap",alignItems:"flex-end"}}>
            <div style={{flex:1,minWidth:"140px"}}>
              <label style={C.label}>From</label>
              <input type="date" style={C.input} value={dateFrom} onChange={e=>{setDateFrom(e.target.value);setPage(1);}}/>
            </div>
            <div style={{flex:1,minWidth:"140px"}}>
              <label style={C.label}>To</label>
              <input type="date" style={C.input} value={dateTo} onChange={e=>{setDateTo(e.target.value);setPage(1);}}/>
            </div>
            {(search||dateFrom||dateTo) &&
              <button style={C.btnGray} onClick={()=>{setSearch("");setDateFrom("");setDateTo("");setPage(1);}}>✕ Clear</button>}
          </div>
        </div>

        {/* ── Patients grid ──────────────────── */}
        <div style={C.card}>
          <div style={{...C.sectionTitle,marginBottom:"20px"}}>
            📋 Patients
            <span style={{...C.badge, background:"#dbeafe", color:"#2563eb"}}>{filtered.length}</span>
          </div>

          {loading ? (
            <div style={C.emptyState}><Spinner/><p style={{marginTop:14,fontSize:14}}>Loading...</p></div>
          ) : filtered.length===0 ? (
            <div style={C.emptyState}>
              <div style={{fontSize:52,marginBottom:12}}>🔍</div>
              <div style={{fontSize:16,fontWeight:700,color:"#475569"}}>No patients found</div>
              <div style={{fontSize:13,marginTop:6}}>Adjust filters or add a new patient</div>
            </div>
          ) : (
            <>
              <div style={C.pageGrid}>
                {paginated.map(p => (
                  <div key={p.id} className="pcard" style={C.patientCard}>

                    {/* Info row */}
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:"8px"}}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:"7px",flexWrap:"wrap",marginBottom:"6px"}}>
                          <span style={C.idTag}>#{p.patientId}</span>
                          <span style={{fontSize:"15px",fontWeight:"700",color:"#0f172a",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:"180px"}}>{p.name}</span>
                        </div>
                        <p style={{fontSize:"13px",color:"#64748b",margin:"2px 0"}}>📞 {p.phoneNumber}</p>
                        <p style={{fontSize:"13px",color:"#475569",margin:"2px 0"}}>📅 <strong>{formatDate(p.visitedDate)}</strong></p>
                        <p style={{fontSize:"11px",color:"#94a3b8",margin:"2px 0"}}>🕒 {formatDateTime(p.createdAt)}</p>
                      </div>
                      {(p.imageCount||0)>0 &&
                        <span style={{...C.badge, background:"linear-gradient(135deg,#10b981,#059669)", color:"#fff", flexShrink:0, fontSize:"11px", padding:"4px 10px"}}>
                          📎 {p.imageCount}
                        </span>}
                    </div>

                    {/* Thumbnail */}
                    {thumbCache[p.id] && (
                      <div style={C.thumbnailWrap} onClick={()=>openViewer(p)}>
                        <img src={thumbCache[p.id]} alt="form" style={C.thumbnail} className="thumb"/>
                        <div style={{position:"absolute",bottom:0,left:0,right:0,padding:"20px 10px 8px", background:"linear-gradient(transparent,rgba(0,0,0,0.5))", borderRadius:"0 0 12px 12px"}}>
                          <span style={{color:"#fff",fontSize:"11px",fontWeight:"600"}}>Click to view all forms</span>
                        </div>
                      </div>
                    )}

                    {/* Actions */}
                    <div style={C.actionRow}>
                      <button className="pbtn" style={C.btnGreen}
                        onClick={()=>{setSelPatient(p);setShowAttach(true);}}>
                        📷 Attach
                      </button>
                      <button className="pbtn" style={C.btnBlue} onClick={()=>openViewer(p)}>
                        👁 View ({p.imageCount||0})
                      </button>
                      {(p.imageCount||0)>0
                        ? <button className="pbtn" style={C.btnPurple}
                            onClick={()=>{ if(thumbCache[p.id]) printImage(thumbCache[p.id],p.name,p.patientId); else { loadImages(p.id).then(imgs=>{ if(imgs[0]) printImage(imgs[0].base64,p.name,p.patientId); }); } }}>
                            🖨 Print
                          </button>
                        : <button style={C.btnDisabled} disabled>🖨 Print</button>}
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination */}
              {totalPages>1 && (
                <div style={C.pagination}>
                  <button style={{...C.pageBtn,opacity:page===1?.5:1}} onClick={()=>page>1&&setPage(p=>p-1)} disabled={page===1}>← Prev</button>
                  {Array.from({length:Math.min(totalPages,7)},(_,i)=>{
                    let n;
                    if (totalPages<=7) n=i+1;
                    else if (page<=4) n=i+1;
                    else if (page>=totalPages-3) n=totalPages-6+i;
                    else n=page-3+i;
                    return (
                      <button key={n} style={{...C.pageBtn, ...(page===n?{background:"linear-gradient(135deg,#3b82f6,#2563eb)",color:"#fff",border:"none"}:{})}}
                        onClick={()=>setPage(n)}>{n}</button>
                    );
                  })}
                  <button style={{...C.pageBtn,opacity:page===totalPages?.5:1}} onClick={()=>page<totalPages&&setPage(p=>p+1)} disabled={page===totalPages}>Next →</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Add Patient Modal ─────────────────── */}
      {showAdd && (
        <div style={C.overlay} onClick={e=>{if(e.target===e.currentTarget)setShowAdd(false);}}>
          <div style={C.modal}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"22px"}}>
              <h2 style={{fontSize:"20px",fontWeight:"800",color:"#0f172a",margin:0}}>Add New Patient</h2>
              <button style={C.closeBtn} onClick={()=>setShowAdd(false)}>✕</button>
            </div>
            <div style={{background:"linear-gradient(135deg,#eff6ff,#f5f3ff)",border:"1.5px solid #c7d2fe",borderRadius:"14px",padding:"14px",marginBottom:"20px"}}>
              <div style={{fontSize:"11px",color:"#6366f1",fontWeight:"700",letterSpacing:"0.5px",marginBottom:"6px"}}>AUTO-ASSIGNED PATIENT ID</div>
              <div style={{background:"linear-gradient(135deg,#3b82f6,#8b5cf6)",color:"#fff",padding:"10px 18px",borderRadius:"10px",display:"inline-block",fontSize:"28px",fontWeight:"900",letterSpacing:"2px"}}>
                #{nextId}
              </div>
            </div>
            <form onSubmit={handleAdd}>
              <div style={{marginBottom:"16px"}}>
                <label style={C.label}>Full Name *</label>
                <input style={C.input} type="text" placeholder="Patient's full name"
                  value={newPat.name} onChange={e=>setNewPat({...newPat,name:e.target.value})} autoFocus/>
                {formErr.name && <p style={C.errText}>{formErr.name}</p>}
              </div>
              <div style={{marginBottom:"16px"}}>
                <label style={C.label}>Phone Number *</label>
                <input style={C.input} type="tel" placeholder="e.g. 07501234567"
                  value={newPat.phone} onChange={e=>setNewPat({...newPat,phone:e.target.value})}/>
                {formErr.phone && <p style={C.errText}>{formErr.phone}</p>}
              </div>
              <div style={{marginBottom:"24px"}}>
                <label style={C.label}>Visit Date *</label>
                <input style={C.input} type="date" value={newPat.date} onChange={e=>setNewPat({...newPat,date:e.target.value})}/>
              </div>
              <div style={{display:"flex",gap:"10px"}}>
                <button type="button" style={{...C.btnGray,flex:1,padding:"12px",textAlign:"center"}} onClick={()=>setShowAdd(false)}>Cancel</button>
                <button type="submit" disabled={adding} className="pbtn"
                  style={{...C.btnPrimary,flex:2,justifyContent:"center",padding:"12px",opacity:adding?.7:1}}>
                  {adding?"Adding...":"✓ Add Patient"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Attach Image Modal ────────────────── */}
      {showAttach && selPatient && (
        <div style={C.overlay} onClick={e=>{if(e.target===e.currentTarget&&!processing){setShowAttach(false);setSelPatient(null);}}}>
          <div style={C.modal}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"8px"}}>
              <h2 style={{fontSize:"20px",fontWeight:"800",color:"#0f172a",margin:0}}>Attach Form</h2>
              {!processing && <button style={C.closeBtn} onClick={()=>{setShowAttach(false);setSelPatient(null);}}>✕</button>}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:"22px",padding:"10px 14px",background:"#f8fafc",borderRadius:"10px",border:"1px solid #e2e8f0"}}>
              <span style={{...C.idTag,fontSize:"12px"}}>#{selPatient.patientId}</span>
              <span style={{fontSize:"14px",fontWeight:"600",color:"#1e293b"}}>{selPatient.name}</span>
            </div>

            {processing ? (
              <div style={{textAlign:"center",padding:"40px 20px"}}>
                <Spinner size={52}/>
                <p style={{marginTop:"18px",fontSize:"17px",fontWeight:"700",color:"#1e293b"}}>{progress}</p>
                <p style={{fontSize:"13px",color:"#64748b",marginTop:"6px"}}>Converting to grayscale & compressing...</p>
                <div style={{marginTop:"16px",background:"#f1f5f9",borderRadius:"8px",height:"6px",overflow:"hidden"}}>
                  <div style={{height:"100%",background:"linear-gradient(90deg,#3b82f6,#8b5cf6)",borderRadius:"8px",animation:"pgrow 2s ease infinite",width:"60%"}}/>
                </div>
              </div>
            ) : (
              <div style={{display:"flex",flexDirection:"column",gap:"12px"}}>
                <button className="pbtn" onClick={handleCamera} style={{
                  width:"100%",padding:"20px",borderRadius:"16px",border:"2px solid #86efac",
                  background:"linear-gradient(135deg,#f0fdf4,#dcfce7)",color:"#15803d",
                  fontSize:"15px",fontWeight:"700",cursor:"pointer",display:"flex",alignItems:"center",gap:"14px",
                }}>
                  <span style={{fontSize:"32px",lineHeight:1}}>📸</span>
                  <div style={{textAlign:"left"}}>
                    <div>Take Photo with Camera</div>
                    <div style={{fontSize:"12px",fontWeight:"400",color:"#4ade80",marginTop:"3px"}}>Use device camera</div>
                  </div>
                </button>
                <button className="pbtn" onClick={handleFile} style={{
                  width:"100%",padding:"20px",borderRadius:"16px",border:"2px solid #93c5fd",
                  background:"linear-gradient(135deg,#eff6ff,#dbeafe)",color:"#1d4ed8",
                  fontSize:"15px",fontWeight:"700",cursor:"pointer",display:"flex",alignItems:"center",gap:"14px",
                }}>
                  <span style={{fontSize:"32px",lineHeight:1}}>📁</span>
                  <div style={{textAlign:"left"}}>
                    <div>Upload from Device</div>
                    <div style={{fontSize:"12px",fontWeight:"400",color:"#60a5fa",marginTop:"3px"}}>Choose from gallery or files</div>
                  </div>
                </button>
                <div style={{padding:"10px 14px",background:"#fefce8",borderRadius:"10px",border:"1px solid #fde047",fontSize:"12px",color:"#854d0e"}}>
                  💡 Saved as grayscale for smaller storage. Multiple forms allowed per patient.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Image Viewer Modal ────────────────── */}
      {showViewer && selPatient && (
        <div style={C.overlay} onClick={e=>{if(e.target===e.currentTarget){setShowViewer(false);setSelPatient(null);setViewImgs([]);}}}>
          <div style={C.modalWide}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"6px"}}>
              <h2 style={{fontSize:"19px",fontWeight:"800",color:"#0f172a",margin:0}}>{selPatient.name}'s Forms</h2>
              <button style={C.closeBtn} onClick={()=>{setShowViewer(false);setSelPatient(null);setViewImgs([]);}}>✕</button>
            </div>
            <p style={{fontSize:"13px",color:"#64748b",marginBottom:"16px"}}>
              ID #{selPatient.patientId} · {viewImgs.length} form{viewImgs.length!==1?"s":""} · Visit: {formatDate(selPatient.visitedDate)}
            </p>
            <button className="pbtn" style={{...C.btnGreen,width:"100%",justifyContent:"center",padding:"11px",marginBottom:"16px"}}
              onClick={()=>{setShowViewer(false);setShowAttach(true);}}>
              ＋ Attach Another Form
            </button>

            {loadingImgs ? (
              <div style={{textAlign:"center",padding:"40px"}}><Spinner/><p style={{marginTop:12,color:"#64748b",fontSize:14}}>Loading...</p></div>
            ) : viewImgs.length===0 ? (
              <div style={C.emptyState}>
                <div style={{fontSize:40,marginBottom:10}}>📂</div>
                <div style={{fontWeight:600}}>No forms yet</div>
              </div>
            ) : viewImgs.map((img,i) => (
              <div key={img.imageId} style={{border:"1.5px solid #e2e8f0",borderRadius:"14px",overflow:"hidden",marginBottom:"14px"}}>
                <div style={{padding:"8px 12px",background:"#f8fafc",borderBottom:"1px solid #e2e8f0",display:"flex",justifyContent:"space-between"}}>
                  <span style={{fontSize:"12px",color:"#64748b",fontWeight:"600"}}>Form {i+1} of {viewImgs.length}</span>
                  <span style={{fontSize:"11px",color:"#94a3b8"}}>{formatDateTime(img.uploadedAt)}</span>
                </div>
                <img src={img.base64} alt={`Form ${i+1}`} style={{width:"100%",height:"auto",display:"block",cursor:"pointer"}}
                  onClick={()=>{setImgIdx(i);setShowFull(true);}}/>
                <div style={{display:"flex",gap:"8px",padding:"10px 12px",background:"#f8fafc",borderTop:"1px solid #e2e8f0"}}>
                  <button className="pbtn" style={{...C.btnGreen,flex:1,justifyContent:"center"}}
                    onClick={()=>printImage(img.base64,selPatient.name,selPatient.patientId)}>
                    🖨 Print
                  </button>
                  <button className="pbtn" style={{...C.btnBlue,flex:1,justifyContent:"center"}}
                    onClick={()=>{setImgIdx(i);setShowFull(true);}}>
                    🔍 Fullscreen
                  </button>
                  <button className="pbtn" style={{...C.btnRed,flex:1,justifyContent:"center"}}
                    onClick={()=>handleDelete(img.imageId)}>
                    🗑 Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Fullscreen viewer ─────────────────── */}
      {showFull && viewImgs.length>0 && selPatient && (
        <div style={{...C.overlay,background:"rgba(0,0,0,0.96)",flexDirection:"column",padding:"0"}}
          onClick={e=>{if(e.target===e.currentTarget)setShowFull(false);}}>
          {/* top bar */}
          <div style={{width:"100%",padding:"14px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",background:"rgba(0,0,0,0.6)",flexShrink:0}}>
            <span style={{color:"#fff",fontWeight:"700",fontSize:"15px"}}>{selPatient.name} · Form {imgIdx+1}/{viewImgs.length}</span>
            <div style={{display:"flex",gap:"8px"}}>
              <button className="pbtn" style={{...C.btnGreen,padding:"8px 16px"}} onClick={()=>printImage(viewImgs[imgIdx].base64,selPatient.name,selPatient.patientId)}>🖨 Print</button>
              <button style={C.closeBtn} onClick={()=>setShowFull(false)}>✕</button>
            </div>
          </div>
          {/* image */}
          <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",padding:"12px"}}>
            <img src={viewImgs[imgIdx].base64} alt="fullscreen" style={{maxWidth:"100%",maxHeight:"calc(100vh - 160px)",objectFit:"contain",borderRadius:"8px"}}/>
          </div>
          {/* nav */}
          <div style={{padding:"14px 20px",display:"flex",justifyContent:"center",gap:"12px",background:"rgba(0,0,0,0.6)",flexShrink:0}}>
            <button style={{...C.btnGray,padding:"9px 22px",opacity:imgIdx===0?.4:1}} disabled={imgIdx===0} onClick={()=>setImgIdx(i=>i-1)}>← Prev</button>
            <span style={{color:"rgba(255,255,255,0.6)",padding:"9px 0",fontSize:"14px"}}>{imgIdx+1} / {viewImgs.length}</span>
            <button style={{...C.btnGray,padding:"9px 22px",opacity:imgIdx===viewImgs.length-1?.4:1}} disabled={imgIdx===viewImgs.length-1} onClick={()=>setImgIdx(i=>i+1)}>Next →</button>
            <button className="pbtn" style={{...C.btnRed,padding:"9px 18px"}} onClick={()=>{if(confirm("Delete?")){handleDelete(viewImgs[imgIdx].imageId);if(viewImgs.length===1)setShowFull(false);}}}>🗑 Delete</button>
          </div>
        </div>
      )}

      <style>{`@keyframes pgrow{0%{width:20%}50%{width:80%}100%{width:20%}}`}</style>
    </div>
  );
}