import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, collection, addDoc, updateDoc, onSnapshot, query, where, orderBy, limit, serverTimestamp, writeBatch, deleteDoc, runTransaction, increment, getDocs, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { PIX_PAYLOAD, PIX_CHAVE } from "./pix.js";
import { MOTORISTA_NOME, MOTORISTA_ZAP } from "./motorista.js";
import * as cfg from "./config.js";
const { firebaseConfig, ADMIN_EMAIL } = cfg;

// Avisa o motorista pelo ntfy.sh (notificação com o app fechado)
async function avisarMotorista(nome){
  if (!cfg.NTFY_TOPIC || cfg.NTFY_TOPIC.includes("COLE")) return;
  try {
    await fetch("https://ntfy.sh/", { method:"POST", body: JSON.stringify({
      topic: cfg.NTFY_TOPIC, title: "LZ EXPRESS - Novo chamado!",
      message: nome + " está chamando um moto táxi.", priority: 5, tags: ["motorcycle"],
      click: location.origin + location.pathname
    })});
  } catch {}
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const authSec = getAuth(initializeApp(firebaseConfig, "sec")); // cria contas de motoristas sem deslogar o admin
const db = getFirestore(app);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

let EU = null, cadastrando = null; const fones = {};
let modoCadastro = false, unsubs = [], audioCtx = null;
const parar = () => { unsubs.forEach(f => f()); unsubs = []; monitorarChat(null); seguirGPS(null); };

function tela(id){ ["loading","auth","cliente","motorista"].forEach(t => $(t).classList.toggle("hidden", t !== id)); }
function erroMsg(e){
  const m = {
    "auth/invalid-email":"E-mail inválido. Confira se digitou certo.",
    "auth/missing-password":"Digite sua senha.",
    "auth/weak-password":"A senha precisa ter pelo menos 6 caracteres.",
    "auth/email-already-in-use":"Este e-mail já tem cadastro. Toque em “Entrar”.",
    "app/senha-diferente":"Este e-mail já tem conta, mas a senha não confere. Toque em “Entrar” com a senha antiga ou em “Esqueci minha senha”.",
    "auth/invalid-credential":"E-mail ou senha incorretos.",
    "auth/user-not-found":"E-mail ou senha incorretos.",
    "auth/wrong-password":"E-mail ou senha incorretos.",
    "auth/too-many-requests":"Muitas tentativas. Aguarde um pouco e tente de novo.",
    "auth/network-request-failed":"Sem internet. Verifique sua conexão."
  };
  return m[e.code] || "Algo deu errado. Tente novamente.";
}

/* ---------- Login / cadastro ---------- */
const imgLogo = new Image();
imgLogo.onload = () => $("auth").classList.add("com-logo");
imgLogo.src = "assets/fundo.png?v=2";

function setModo(cad){
  modoCadastro = cad;
  $("aba-entrar").classList.toggle("ativa", !cad);
  $("aba-criar").classList.toggle("ativa", cad);
  $("campos-cadastro").classList.toggle("hidden", !cad);
  $("btn-auth").textContent = cad ? "Criar minha conta" : "Entrar";
  $("senha").autocomplete = cad ? "new-password" : "current-password";
  $("erro").textContent = "";
}
$("aba-entrar").onclick = () => setModo(false);
$("aba-criar").onclick = () => setModo(true);

$("btn-auth").onclick = async () => {
  const email = $("email").value.trim(), senha = $("senha").value;
  const nome = $("nome").value.trim(), telefone = $("telefone").value.trim();
  $("erro").textContent = "";
  if (!email || !senha) { $("erro").textContent = "Preencha e-mail e senha."; return; }
  if (modoCadastro && (!nome || !telefone)) { $("erro").textContent = "Preencha seu nome e telefone."; return; }
  $("btn-auth").disabled = true;
  try {
    if (modoCadastro) {
      cadastrando = { nome, telefone, email };
      try {
        const c = await createUserWithEmailAndPassword(auth, email, senha);
        await setDoc(doc(db, "users", c.user.uid), { nome, telefone, email, criadoEm: serverTimestamp() }, { merge:true });
      } catch (e) {
        if (e.code !== "auth/email-already-in-use") throw e;
        let c;
        try { c = await signInWithEmailAndPassword(auth, email, senha); }
        catch { cadastrando = null; throw Object.assign(new Error("senha"), { code: "app/senha-diferente" }); }
        await setDoc(doc(db, "users", c.user.uid), { nome, telefone, email, criadoEm: serverTimestamp() }, { merge:true });
      }
    } else {
      await signInWithEmailAndPassword(auth, email, senha);
    }
  } catch (e) { $("erro").textContent = erroMsg(e); }
  $("btn-auth").disabled = false;
};

$("btn-esqueci").onclick = async () => {
  const email = $("email").value.trim();
  if (!email) { $("erro").textContent = "Digite seu e-mail acima e toque de novo."; return; }
  try { await sendPasswordResetEmail(auth, email); $("erro").style.color = "#2E7D5B"; $("erro").textContent = "Enviamos um e-mail para criar nova senha."; }
  catch (e) { $("erro").style.color = ""; $("erro").textContent = erroMsg(e); }
};

$("ver-senha").onclick = () => {
  const ver = $("senha").type === "password";
  $("senha").type = ver ? "text" : "password";
  $("ver-senha").textContent = ver ? "Ocultar" : "Mostrar";
};

document.querySelectorAll("[data-sair]").forEach(b => b.onclick = async () => {
  try { if (EU) await setDoc(doc(db,"disponibilidade",EU.uid), { online:false }, { merge:true }); } catch {}
  signOut(auth);
});

const DESATIVADO = "Sua conta de motorista está desativada. Fale com o administrador.";
onAuthStateChanged(auth, async user => {
  parar(); EU = null;
  if (!user) { tela("auth"); return; }
  unsubs.push(onSnapshot(doc(db,"config","plano"), d => { if (d.exists()) PLANO = { dias: d.data().dias ?? 15, valor: d.data().valor ?? 100 }; atualizarPlanoUI(); }, () => {}));
  if (user.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) { iniciarPainel(user, true, null); tela("motorista"); return; }
  try {
    const m = await getDoc(doc(db,"motoristas",user.uid));
    if (m.exists()) {
      if (!m.data().ativo) { alert(DESATIVADO); await signOut(auth); return; }
      iniciarPainel(user, false, m.data());
      const v0 = m.data().validoAte ? m.data().validoAte.toMillis() : 0;
      unsubs.push(onSnapshot(doc(db,"motoristas",user.uid), d => {
        if (!d.exists()) return;
        if (!d.data().ativo) { alert(DESATIVADO); signOut(auth); return; }
        if ((d.data().validoAte ? d.data().validoAte.toMillis() : 0) !== v0) location.reload();
      }));
      tela("motorista"); return;
    }
  } catch {}
  if (cadastrando) {
    const p = cadastrando; cadastrando = null;
    try { await setDoc(doc(db,"users",user.uid), { ...p, criadoEm: serverTimestamp() }, { merge:true }); } catch {}
  }
  iniciarCliente(user); tela("cliente");
});

/* ---------- Cliente ---------- */
const TEXTOS = {
  aguardando:["Procurando o moto táxi...","Seu chamado foi enviado. Aguarde um instante.",""],
  aceito:["Moto a caminho! 🏍️","O moto táxi aceitou e está indo até você. Fique no local e use o botão abaixo para conversar.","aceito"],
  finalizado:["Corrida finalizada","Obrigado por usar o LZ EXPRESS!","final"],
  cancelado:["Chamado cancelado","Você pode chamar novamente quando quiser.","final"]
};
const MOTIVOS_CLIENTE = {
  nao_encontrado:"Não conseguimos te encontrar. Chame de novo e escreva um ponto de referência.",
  fora_area:"Desculpe, seu local está fora da área de atendimento.",
  sem_resposta:"Tentamos falar com você e não conseguimos contato. Chame de novo quando puder.",
  indisponivel:"No momento não há moto disponível. Tente de novo em alguns minutos.",
  problema_moto:"Tivemos um problema com a moto e não conseguimos atender. Pedimos desculpas, tente de novo mais tarde.",
  duplicado:"Seu chamado estava repetido e foi cancelado. Se ainda precisar, chame de novo.",
  desistiu:"Chamado encerrado a pedido do cliente."
};
function textoStatus(c){
  if (c.status === "aguardando" && c.aviso === "aguardar") return ["Aguarde um pouquinho","Os moto táxis estão ocupados no momento. Aguarde um pouco, assim que um aceitar você será atendido!",""];
  if (c.status === "aceito") return ["Moto a caminho! 🏍️", (c.motoristaNome || MOTORISTA_NOME) + " aceitou seu chamado e está indo até você. Fique no local.","aceito"];
  if (c.status === "cancelado" && MOTIVOS_CLIENTE[c.motivo]) return ["Chamado cancelado", MOTIVOS_CLIENTE[c.motivo], "final"];
  return TEXTOS[c.status] || TEXTOS.aguardando;
}
function iniciarCliente(user){
  unsubs.push(onSnapshot(doc(db,"solicitacoes",user.uid), d => { solicitacao = d.exists() ? d.data() : null; atualizarParceiro(); }, () => {}));
  getDoc(doc(db,"users",user.uid)).then(s => { $("ola").textContent = s.exists() ? "Olá, " + s.data().nome.split(" ")[0] + "!" : "Olá!"; }).catch(()=>{});
  let ativo = null, online = null;
  const atualizarBotao = () => {
    $("bloco-chamar").classList.toggle("hidden", !!ativo || online !== true);
    $("selo-online").classList.toggle("hidden", online !== true);
    $("aviso-offline").classList.toggle("hidden", !!ativo || online !== false);
  };
  unsubs.push(onSnapshot(collection(db,"disponibilidade"),
    snap => { online = snap.docs.some(d => d.data().online === true); atualizarBotao(); },
    () => { online = false; atualizarBotao(); }));
  unsubs.push(onSnapshot(query(collection(db,"chamados"), where("uid","==",user.uid)), snap => {
    const todos = snap.docs.map(d => ({id:d.id, ...d.data()}));
    todos.sort((a,b) => (b.criadoEm?.seconds ?? 9e9) - (a.criadoEm?.seconds ?? 9e9));
    const ult = todos[0];
    ativo = ult && ["aguardando","aceito"].includes(ult.status) ? ult : null;
    atualizarBotao();
    $("btn-cancelar").classList.toggle("hidden", !(ativo && ativo.status === "aguardando"));
    const aceito = ult && ult.status === "aceito" ? ult : null;
    monitorarChat(aceito ? aceito.id : null);
    if (!ult) { $("status").classList.add("hidden"); return; }
    const t = textoStatus(ult);
    $("status").className = "status " + t[2];
    $("status-titulo").textContent = t[0]; $("status-texto").textContent = t[1];
    aoMudarChat = () => { const n = naoLidas(); $("btn-chat-cli").textContent = "💬 Conversar com o motorista" + (n ? ` (${n} nova${n > 1 ? "s" : ""})` : ""); };
    aoMudarChat();
    $("btn-chat-cli").classList.toggle("hidden", !aceito);
    $("btn-chat-cli").onclick = () => aceito && abrirChat(aceito.id, aceito.motoristaNome || "o motorista");
    ultCh = aceito;
    $("btn-loc-cli").classList.toggle("hidden", !aceito);
    if (!aceito) $("loc-tela").classList.add("hidden"); else if (!$("loc-tela").classList.contains("hidden")) desenharLoc();
    const ign = (() => { try { return JSON.parse(localStorage.getItem("lz_ign") || "[]"); } catch { return []; } })();
    if (ult.status === "finalizado" && ult.motoristaId && !ult.nota && !ign.includes(ult.id)) {
      notaId = ult.id; $("nota-sub").textContent = "Avalie " + (ult.motoristaNome || "o motorista"); $("nota-tela").classList.remove("hidden");
    } else if (notaId === ult.id || ult.nota) { notaId = null; $("nota-tela").classList.add("hidden"); }
  }, () => alert("Não foi possível carregar. Verifique a internet.")));

  $("btn-cancelar").onclick = () => ativo && updateDoc(doc(db,"chamados",ativo.id), { status:"cancelado" });
  $("btn-chamar").onclick = async () => {
    const btn = $("btn-chamar");
    if (!navigator.geolocation) { alert("Seu celular não permite localização."); return; }
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(async pos => {
      try {
        const s = await getDoc(doc(db,"users",user.uid));
        let u;
        if (s.exists()) u = s.data();
        else {
          const nome = (prompt("Digite seu nome:") || "").trim();
          const telefone = (prompt("Digite seu telefone (WhatsApp):") || "").trim();
          if (!nome || !telefone) { btn.disabled = false; return; }
          u = { nome, telefone, email: user.email };
          await setDoc(doc(db,"users",user.uid), { ...u, criadoEm: serverTimestamp() }, { merge:true });
          $("ola").textContent = "Olá, " + nome.split(" ")[0] + "!";
        }
        const ch = doc(collection(db,"chamados")), lote = writeBatch(db);
        lote.set(ch, {
          uid:user.uid, nome:u.nome, referencia:$("referencia").value.trim().slice(0,120),
          lat:pos.coords.latitude, lng:pos.coords.longitude, precisao:Math.round(pos.coords.accuracy),
          status:"aguardando", criadoEm:serverTimestamp()
        });
        lote.set(doc(db,"contatos",ch.id), { uid:user.uid, telefone:u.telefone });
        lote.set(doc(db,"users",user.uid), { ultimoChamado:serverTimestamp() }, { merge:true });
        await lote.commit();
        avisarMotorista((u.nome||"Cliente").split(" ")[0]);
        $("referencia").value = "";
      } catch { alert("Não foi possível enviar o chamado. Espere 1 minuto e tente de novo."); }
      btn.disabled = false;
    }, err => {
      btn.disabled = false;
      alert(err.code === 1 ? "Você não permitiu a localização. Toque no cadeado do navegador, permita a localização e tente de novo." : "Não conseguimos achar sua localização. Vá para um local aberto e tente de novo.");
    }, { enableHighAccuracy:true, timeout:20000, maximumAge:0 });
  };
}

/* ---------- Motorista ---------- */
function beep(){
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    [0,0.35,0.7].forEach(t => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.4, audioCtx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t + 0.3);
      o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.3);
    });
    navigator.vibrate && navigator.vibrate([300,150,300]);
  } catch {}
}
const fmt = (t, soHora) => !t ? "agora" : new Date(t.seconds*1000).toLocaleString("pt-BR",
  soHora ? {hour:"2-digit",minute:"2-digit"} : {day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
const MOT_TXT = {nao_encontrado:"cliente não encontrado", fora_area:"fora da área", sem_resposta:"sem resposta", indisponivel:"sem moto disponível", problema_moto:"problema com a moto", duplicado:"duplicado", desistiu:"cliente desistiu"};
const NOMES = {aguardando:"Aguardando",aceito:"Em andamento",finalizado:"Finalizada",cancelado:"Cancelada"};
function abaMot(qual){
  [["ativos","aba-ativos","lista"],["hist","aba-hist","hist"],["clientes","aba-clientes","clientes"],["motoristas","aba-motoristas","motoristas"]].forEach(([n,aba,box]) => {
    $(aba).classList.toggle("ativa", n === qual); $(box).classList.toggle("hidden", n !== qual);
  });
}
function montarPix(chave, nome, valor){
  const t = (i,v) => i + String(v.length).padStart(2,"0") + v;
  const n = nome.normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^A-Za-z0-9 ]/g,"").toUpperCase().slice(0,25) || "MOTORISTA";
  const p = t("00","01")+t("01","11")+t("26",t("00","br.gov.bcb.pix")+t("01",chave.trim()))+t("52","0000")+t("53","986")+(valor ? t("54",Number(valor).toFixed(2)) : "")+t("58","BR")+t("59",n)+t("60","BELEM")+t("62",t("05","***"))+"6304";
  let c = 0xFFFF;
  for (const ch of new TextEncoder().encode(p)) { c ^= ch << 8; for (let k=0;k<8;k++) c = (c & 0x8000) ? ((c<<1)^0x1021)&0xFFFF : (c<<1)&0xFFFF; }
  return p + c.toString(16).toUpperCase().padStart(4,"0");
}
let pixAtual = "";
function abrirPix(nome, payload, info = "", zap = ""){
  pixAtual = payload; $("pix-nome").textContent = nome; $("pix-info").textContent = info; $("pix-qr").innerHTML = "";
  $("pix-avisar").classList.toggle("hidden", !zap); if (zap) $("pix-avisar").href = zap;
  if (window.QRCode) new QRCode($("pix-qr"), { text: payload, width:260, height:260, correctLevel: QRCode.CorrectLevel.M });
  else $("pix-qr").textContent = "Sem internet para gerar o QR. Use o botão abaixo para copiar o código Pix.";
  $("pix-tela").classList.remove("hidden");
}
function carregarFone(c, depois){
  fones[c.id] = null;
  const fim = f => { fones[c.id] = f; depois(); };
  getDoc(doc(db,"contatos",c.id)).then(s => fim(s.exists() ? s.data().telefone : (c.telefone || ""))).catch(() => fim(c.telefone || ""));
}
async function aceitar(id){
  try {
    await runTransaction(db, async t => {
      const ref = doc(db,"chamados",id), s = await t.get(ref);
      if (!s.exists() || s.data().status !== "aguardando") throw new Error("ja");
      t.update(ref, { status:"aceito", motoristaId:EU.uid, motoristaNome:EU.nome, aceitoEm:serverTimestamp(), aviso:"" });
      t.set(doc(db,"contagem",EU.uid), { total:increment(1), dias:{ [new Date().toLocaleDateString("sv-SE")]:increment(1) } }, { merge:true });
    });
  } catch (e) { alert(e.message === "ja" ? "Este chamado já foi aceito por outro motorista." : "Não foi possível aceitar. Tente de novo."); }
}
const seg = c => c.criadoEm?.seconds ?? 9e9;

function desenharPlano(){
  if (!EU || EU.admin) return;
  const v = EU.valido, dias = v === null ? null : Math.ceil((v - Date.now()) / 86400000), venc = dias !== null && dias <= 0;
  $("plano-tit").textContent = v === null ? "Plano sem vencimento" : venc ? "Plano vencido" : (EU.pago ? "Plano ativo" : "Teste grátis");
  $("plano-sub").textContent = v === null ? "" : venc ? "Pague a mensalidade para voltar a receber chamados." : dias + (dias === 1 ? " dia restante" : " dias restantes") + " · vence em " + new Date(v).toLocaleDateString("pt-BR");
  const c = $("plano-card");
  c.classList.toggle("ok", v !== null && !venc && dias > 5); c.classList.toggle("av", v !== null && !venc && dias <= 5); c.classList.toggle("ve", venc);
}
const mediaTxt = (soma, total) => total ? (soma / total).toFixed(1).replace(".", ",") + " ★ (" + total + ")" : "sem avaliações";
const tel55 = t => { const d = String(t || "").replace(/\D/g,""); return d.startsWith("55") && d.length > 11 ? d : "55" + d; };

function iniciarPainel(user, admin, perfil){
  const val = perfil && perfil.validoAte ? perfil.validoAte.toMillis() : null;
  const expirado = !admin && val !== null && val < Date.now();
  EU = { uid:user.uid, admin, valido:val, pago:!!(perfil && perfil.ultimoPagamento),
    nome: admin ? MOTORISTA_NOME : perfil.nome,
    zap: (admin ? MOTORISTA_ZAP : perfil.telefone) || "",
    pix: admin ? PIX_PAYLOAD : montarPix(perfil.pixChave || "", perfil.nome),
    pixNome: admin ? "Leandro Vanzeler Vasconcelos · Mercado Pago" : perfil.nome };
  ["aba-clientes","aba-motoristas","btn-apagar"].forEach(i => $(i).classList.toggle("hidden", !admin));
  $("aba-ativos").classList.toggle("hidden", admin);
  $("plano-card").classList.toggle("hidden", admin);
  $("plano-adm").classList.toggle("hidden", !admin);
  $("btn-online").classList.toggle("hidden", expirado || admin);
  document.querySelector("#motorista .abas").classList.toggle("hidden", expirado);
  if (admin) setDoc(doc(db,"disponibilidade",user.uid), { online:false }, { merge:true }).catch(() => {});
  abaMot(admin ? "hist" : "ativos"); desenharPlano(); atualizarPlanoUI();
  if (expirado) { $("lista").innerHTML = `<p class="vazio">Seu plano venceu. Toque em “Pagar mensalidade” para voltar a receber chamados.</p>`; return; }
  let online = false, histL = [], ocupado = false, todosItens = [], desenharMot = null, acumMeu = { soma:0, total:0 };
  const primeira = {}, fontes = {};
  const btn = $("btn-online");
  const atualizarApagar = () => {
    if (!admin) return;
    $("btn-apagar").disabled = !histL.length;
    $("aviso-apagar").classList.add("hidden");
  };
  const render = () => {
    const itens = [...new Map(Object.values(fontes).flat().map(c => [c.id, c])).values()];
    todosItens = itens;
    const abertos = c => ["aguardando","aceito"].includes(c.status);
    ocupado = !admin && itens.some(c => c.status === "aceito" && c.motoristaId === EU.uid);
    const meuAtivo = admin ? null : itens.find(c => c.status === "aceito" && c.motoristaId === EU.uid);
    aoMudarChat = render; monitorarChat(meuAtivo ? meuAtivo.id : null); seguirGPS(meuAtivo ? meuAtivo.id : null);
    const ativos = (admin ? [] : itens.filter(c => (c.status === "aguardando" && !ocupado) || (c.status === "aceito" && c.motoristaId === EU.uid))).sort((a,b) => (a.status==="aceito"?0:1)-(b.status==="aceito"?0:1) || seg(a)-seg(b));
    const hist = itens.filter(c => !abertos(c)).sort((a,b) => seg(b)-seg(a));
    histL = hist; atualizarApagar();
    $("lista").innerHTML = (admin ? `<div class="resumo">Aguardando: ${ativos.length} · Em andamento agora: ${itens.filter(c => c.status === "aceito").length}</div>` : "") + (ativos.length ? ativos.map(c => {
      const meu = c.motoristaId === EU.uid, esp = c.status === "aguardando", ve = admin;
      if (ve && !(c.id in fones)) carregarFone(c, render);
      const fone = ve ? fones[c.id] : null, zap = String(fone || "").replace(/\D/g,"");
      return `<div class="chamado ${esp?"":"aceito"}"><h3>${esc(c.nome)}</h3>
        <div class="info">${fmt(c.criadoEm)} · ${NOMES[c.status]} · precisão ~${c.precisao ?? "?"} m<br>${esp ? "" : "Atendendo: " + esc(c.motoristaNome || "?") + "<br>"}${ve ? (fone ? esc(fone) : (fone === null ? "carregando telefone..." : "")) : (esp ? "Contato pelo chat do app após aceitar" : "")}</div>
        ${c.referencia ? `<div class="ref">Referência: ${esc(c.referencia)}</div>` : ""}
        <div class="acoes">
          <a class="b-mapa" target="_blank" href="https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}">Google Maps</a>
          ${zap ? `<a class="b-zap" target="_blank" href="https://wa.me/${zap.length > 11 ? zap : "55" + zap}">WhatsApp</a>` : ""}
          ${esp ? (ocupado || admin ? "" : `<button class="b-ok" data-a="aceito" data-id="${c.id}">Aceitar</button>`) : `<button class="b-fim" data-a="finalizado" data-id="${c.id}">Finalizar</button>`}
          ${!esp && meu ? `<button class="b-chat" data-chat="${c.id}" data-nome="${esc(c.nome)}">Conversar${chatId === c.id && naoLidas() ? " (" + naoLidas() + ")" : ""}</button>` : ""}
          ${admin && esp ? `<button class="b-esp" data-a="aguardar" data-id="${c.id}" style="grid-column:1/3" ${c.aviso==="aguardar"?"disabled":""}>${c.aviso==="aguardar"?"Cliente avisado para aguardar":"Pedir para aguardar"}</button>` : ""}
        </div></div>`;
    }).join("") : `<p class="vazio">Nenhum chamado por enquanto.</p>`);
    const hoje = new Date().toDateString();
    const feitas = hist.filter(c => c.status === "finalizado" && c.criadoEm && new Date(c.criadoEm.seconds*1000).toDateString() === hoje).length;
    let nota = "";
    if (!admin) { const mine = itens.filter(c => c.motoristaId === EU.uid && c.nota); nota = " · Minha nota: " + mediaTxt(mine.reduce((a,c) => a + c.nota, 0) + (acumMeu.soma || 0), mine.length + (acumMeu.total || 0)); }
    $("resumo").textContent = `Corridas finalizadas hoje: ${feitas} · No histórico: ${hist.length}${nota}`;
    $("lista-hist").innerHTML = hist.length ? hist.map(c => {
      const meu = !admin && c.motoristaId === EU.uid;
      return `<div class="chamado ${c.status==="finalizado"?"aceito":"fim"}"><h3>${esc(c.nome)}</h3>
        <div class="info">${fmt(c.criadoEm)} · ${NOMES[c.status]}${MOT_TXT[c.motivo] ? " ("+MOT_TXT[c.motivo]+")" : ""}${admin && c.motoristaNome ? "<br>Motorista: " + esc(c.motoristaNome) : ""}${c.finalizadoEm ? `<br>Encerrada às ${fmt(c.finalizadoEm,true)}` : ""}${c.nota ? `<br>Nota: <span class="val-av">${"★".repeat(c.nota)}${"☆".repeat(5 - c.nota)}</span>` : ""}</div>
        ${c.status==="finalizado" && meu ? `<div class="acoes"><button class="b-ok" data-pix="1" style="grid-column:1/3">Receber por Pix</button></div>` : ""}</div>`;
    }).join("") : `<p class="vazio">Nenhuma corrida no histórico ainda.</p>`;
    if (desenharMot) desenharMot();
  };
  const ouvir = (chave, q) => unsubs.push(onSnapshot(q, snap => {
    if (primeira[chave] && snap.docChanges().some(c => c.type === "added" && c.doc.data().status === "aguardando") && !admin && !ocupado) beep();
    primeira[chave] = true;
    fontes[chave] = snap.docs.map(d => ({id:d.id, ...d.data()}));
    render();
  }, e => alert("Erro ao carregar chamados: " + e.code)));
  const col = collection(db,"chamados");
  if (admin) ouvir("todos", query(col, orderBy("criadoEm","desc"), limit(100)));
  else {
    ouvir("espera", query(col, where("status","==","aguardando"))); ouvir("meus", query(col, where("motoristaId","==",user.uid)));
    unsubs.push(onSnapshot(doc(db,"avaliacoes",user.uid), d => { acumMeu = d.exists() ? d.data() : { soma:0, total:0 }; render(); }, () => {}));
  }
  if (!admin) unsubs.push(onSnapshot(doc(db,"disponibilidade",user.uid), d => {
    online = d.exists() && d.data().online === true;
    btn.className = "toggle " + (online ? "on" : "off");
    btn.innerHTML = '<i class="pt"></i>' + (online ? "ONLINE · toque para ficar offline" : "OFFLINE · toque para ficar online");
    atualizarApagar();
  }));
  btn.onclick = () => setDoc(doc(db,"disponibilidade",user.uid), { online:!online, atualizadoEm:serverTimestamp() }).catch(() => alert("Não foi possível mudar o status."));
  $("aba-ativos").onclick = () => abaMot("ativos");
  $("aba-hist").onclick = () => abaMot("hist");
  if (!admin) return;

  $("aba-clientes").onclick = () => abaMot("clientes");
  $("aba-motoristas").onclick = () => abaMot("motoristas");
  const alterna = (boxId, btnId) => { const oculto = $(boxId).classList.toggle("hidden"); $(btnId).classList.toggle("sel", !oculto); };
  $("btn-mostrar-form").onclick = () => alterna("form-mot", "btn-mostrar-form");
  $("btn-mostrar-lista").onclick = () => alterna("lista-motoristas", "btn-mostrar-lista");
  $("btn-mostrar-sol").onclick = () => alterna("lista-solicitacoes", "btn-mostrar-sol");
  $("btn-apagar").onclick = async () => {
    if (!histL.length) return;
    if (!confirm("Apagar " + histL.length + " corridas do histórico? Isso não pode ser desfeito.")) return;
    try {
      const por = {};
      histL.forEach(c => { if (c.nota && c.motoristaId) { const a = por[c.motoristaId] || (por[c.motoristaId] = { soma:0, total:0 }); a.soma += c.nota; a.total++; } });
      for (const [mid, a] of Object.entries(por)) await setDoc(doc(db,"avaliacoes",mid), { soma:increment(a.soma), total:increment(a.total) }, { merge:true });
      const refs = [];
      for (const c of histL) {
        refs.push(doc(db,"chamados",c.id), doc(db,"contatos",c.id));
        (await getDocs(collection(db,"chamados",c.id,"mensagens"))).forEach(d => refs.push(d.ref));
      }
      for (let k = 0; k < refs.length; k += 400) {
        const lote = writeBatch(db); refs.slice(k, k+400).forEach(r => lote.delete(r)); await lote.commit();
      }
    } catch { alert("Não foi possível apagar. Tente de novo."); }
  };
  $("btn-plano-edit").onclick = () => {
    const dias = parseInt(prompt("Dias de teste grátis:", PLANO.dias), 10); if (!(dias >= 0)) return;
    const valor = parseFloat(String(prompt("Valor da mensalidade (R$):", PLANO.valor)).replace(",", ".")); if (!(valor > 0)) return;
    setDoc(doc(db,"config","plano"), { dias, valor }).catch(() => alert("Não foi possível salvar."));
  };

  let clientes = [];
  const mostrarClientes = () => {
    const q = $("busca-cliente").value.trim().toLowerCase();
    const lista = clientes.filter(c => !q || (c.nome||"").toLowerCase().includes(q) || (c.telefone||"").includes(q));
    $("lista-clientes").innerHTML = lista.length ? lista.map(c => {
      const fone = (c.telefone||"").replace(/\D/g,"");
      return `<div class="chamado aceito"><h3>${esc(c.nome)}</h3><div class="info">${esc(c.telefone)}</div>
        <div class="acoes"><a class="b-zap" target="_blank" href="https://wa.me/55${fone}">WhatsApp</a>
        <button class="b-cancel" data-del="${c.id}" data-nome="${esc(c.nome)}" type="button">Apagar</button></div></div>`;
    }).join("") : `<p class="vazio">Nenhum cliente encontrado.</p>`;
  };
  $("busca-cliente").oninput = mostrarClientes;
  $("lista-clientes").onclick = e => {
    const b = e.target.closest("[data-del]"); if (!b) return;
    if (!confirm("Apagar " + b.dataset.nome + " dos contatos? O login dela continua existindo; no próximo chamado o app pedirá nome e telefone de novo.")) return;
    deleteDoc(doc(db,"users",b.dataset.del)).catch(() => alert("Não foi possível apagar. Tente de novo."));
  };
  unsubs.push(onSnapshot(collection(db,"users"), snap => {
    clientes = snap.docs.map(d => ({id:d.id, ...d.data()})).filter(c => (c.email||"").toLowerCase() !== ADMIN_EMAIL.toLowerCase())
      .sort((a,b) => (a.nome||"").localeCompare(b.nome||"","pt-BR"));
    mostrarClientes();
  }, () => {}));

  let sols = [];
  const desenharSol = () => {
    const pend = sols.filter(x => x.status === "pendente").sort((a,b) => seg(a) - seg(b));
    $("btn-mostrar-sol").textContent = "Solicitações de motoristas (" + pend.length + ")";
    $("aba-motoristas").textContent = "Motoristas" + (pend.length ? " (" + pend.length + ")" : "");
    $("lista-solicitacoes").innerHTML = pend.length ? pend.map(x => `<div class="chamado"><h3>${esc(x.nome)}</h3>
      <div class="info">${esc(x.email)} · ${esc(x.telefone)}<br>Aceitou os termos em ${fmt(x.aceiteEm)} (v${esc(x.versaoTermos)})</div>
      <div class="acoes"><a class="b-zap" target="_blank" href="https://wa.me/${tel55(x.telefone)}" style="grid-column:1/3">WhatsApp</a>
      <button class="b-ok" data-sol="ok" data-id="${x.id}">Aprovar</button><button class="b-cancel" data-sol="no" data-id="${x.id}">Recusar</button></div></div>`).join("")
      : `<p class="vazio">Nenhuma solicitação no momento.</p>`;
  };
  unsubs.push(onSnapshot(collection(db,"solicitacoes"), snap => { sols = snap.docs.map(d => ({id:d.id, ...d.data()})); desenharSol(); }, () => {}));
  $("lista-solicitacoes").onclick = async e => {
    const b = e.target.closest("[data-sol]"); if (!b) return;
    const x = sols.find(y => y.id === b.dataset.id); if (!x) return;
    try {
      if (b.dataset.sol === "no") { if (confirm("Recusar " + x.nome + "?")) await updateDoc(doc(db,"solicitacoes",x.id), { status:"recusada" }); return; }
      const chave = prompt("Chave Pix de " + x.nome + " (peça pelo WhatsApp):");
      if (!chave || !chave.trim()) return;
      await setDoc(doc(db,"motoristas",x.id), { nome:x.nome, telefone:tel55(x.telefone), email:x.email, pixChave:chave.trim(), ativo:true,
        validoAte: Timestamp.fromMillis(Date.now() + PLANO.dias * 86400000), criadoEm:serverTimestamp() });
      await updateDoc(doc(db,"solicitacoes",x.id), { status:"aprovada" });
      alert(x.nome + " aprovado! Peça para ele fechar e abrir o app.");
    } catch { alert("Não foi possível concluir. Tente de novo."); }
  };

  let mots = [], cont = {}, acum = {};
  const desenhar = () => {
    $("btn-mostrar-lista").textContent = "Ver motoristas cadastrados (" + mots.length + ")";
    const mes = new Date().toLocaleDateString("sv-SE").slice(0,7), dia = new Date().toLocaleDateString("sv-SE");
    $("lista-motoristas").innerHTML = mots.length ? mots.map(m => {
      const c = cont[m.id] || {}, dias = c.dias || {};
      const noMes = Object.entries(dias).filter(([d]) => d.startsWith(mes)).reduce((x,[,v]) => x + v, 0);
      const v = m.validoAte ? m.validoAte.toMillis() : null, d = v === null ? null : Math.ceil((v - Date.now()) / 86400000);
      const plano = v === null ? "Plano: sem vencimento" : d <= 0 ? "Plano: VENCIDO" : (m.ultimoPagamento ? "Plano ativo" : "Teste grátis") + ": " + d + (d === 1 ? " dia" : " dias");
      const cor = v === null ? "" : d <= 0 ? "val-ve" : d <= 5 ? "val-av" : "val-ok";
      const its = todosItens.filter(z => z.motoristaId === m.id && z.nota), a = acum[m.id] || {};
      const nota = mediaTxt(its.reduce((s2,z) => s2 + z.nota, 0) + (a.soma || 0), its.length + (a.total || 0));
      return `<div class="chamado ${m.ativo?"aceito":"fim"}"><h3>${esc(m.nome)}${m.ativo ? "" : " (desativado)"}</h3>
        <div class="info">${esc(m.email)} · ${esc(m.telefone)}<br>Corridas aceitas: hoje ${dias[dia] || 0} · mês ${noMes} · total ${c.total || 0}<br>Nota: ${nota}<br><span class="${cor}">${plano}</span></div>
        <div class="acoes">
          <button class="b-ok" data-mot="pagou" data-id="${m.id}" style="grid-column:1/3">Registrar pagamento (+30 dias)</button>
          <button class="b-mapa" data-mot="dias" data-id="${m.id}">Dar dias</button>
          <button class="${m.ativo?"b-cancel":"b-ok"}" data-mot="alt" data-id="${m.id}">${m.ativo ? "Desativar" : "Ativar"}</button>
          <button class="b-mapa" data-mot="senha" data-id="${m.id}">Nova senha</button>
          <button class="b-waze" data-mot="pix" data-id="${m.id}">Editar Pix</button>
          <button class="b-fim" data-mot="qr" data-id="${m.id}" style="grid-column:1/3">Ver QR Pix</button>
        </div></div>`;
    }).join("") : `<p class="vazio">Nenhum motorista cadastrado.</p>`;
  };
  desenharMot = desenhar;
  unsubs.push(onSnapshot(collection(db,"motoristas"), snap => { mots = snap.docs.map(d => ({id:d.id, ...d.data()})).sort((a,b) => (a.nome||"").localeCompare(b.nome||"","pt-BR")); desenhar(); }, () => {}));
  unsubs.push(onSnapshot(collection(db,"contagem"), snap => { cont = {}; snap.docs.forEach(d => cont[d.id] = d.data()); desenhar(); }, () => {}));
  unsubs.push(onSnapshot(collection(db,"avaliacoes"), snap => { acum = {}; snap.docs.forEach(d => acum[d.id] = d.data()); desenhar(); }, () => {}));
  $("lista-motoristas").onclick = async e => {
    const b = e.target.closest("[data-mot]"); if (!b) return;
    const m = mots.find(x => x.id === b.dataset.id); if (!m) return;
    const base = Math.max(m.validoAte ? m.validoAte.toMillis() : 0, Date.now());
    try {
      if (b.dataset.mot === "alt") {
        await updateDoc(doc(db,"motoristas",m.id), { ativo:!m.ativo });
        if (m.ativo) await setDoc(doc(db,"disponibilidade",m.id), { online:false }, { merge:true });
      } else if (b.dataset.mot === "pagou") {
        if (confirm("O pagamento de " + m.nome + " caiu no seu banco? Isso libera mais 30 dias.")) await updateDoc(doc(db,"motoristas",m.id), { validoAte: Timestamp.fromMillis(base + 30 * 86400000), ultimoPagamento: serverTimestamp() });
      } else if (b.dataset.mot === "dias") {
        const n = parseInt(prompt("Quantos dias dar para " + m.nome + "?", "7"), 10);
        if (n > 0) await updateDoc(doc(db,"motoristas",m.id), { validoAte: Timestamp.fromMillis(base + n * 86400000) });
      } else if (b.dataset.mot === "senha") {
        await sendPasswordResetEmail(auth, m.email); alert("Enviamos um e-mail para " + m.nome + " criar nova senha.");
      } else if (b.dataset.mot === "pix") {
        const nova = prompt("Chave Pix de " + m.nome + " (CPF, e-mail, +55... ou chave aleatória):", m.pixChave || "");
        if (nova && nova.trim()) await updateDoc(doc(db,"motoristas",m.id), { pixChave:nova.trim() });
      } else abrirPix(m.nome, montarPix(m.pixChave || "", m.nome));
    } catch { alert("Não foi possível concluir. Tente de novo."); }
  };
  $("btn-cad-mot").onclick = async () => {
    const v = id => $(id).value.trim();
    const nome = v("m-nome"), email = v("m-email"), senha = $("m-senha").value, pixChave = v("m-pix");
    let telefone = v("m-telefone").replace(/\D/g,"");
    $("m-erro").style.color = ""; $("m-erro").textContent = "";
    if (!nome || !telefone || !email || senha.length < 6 || !pixChave) { $("m-erro").textContent = "Preencha tudo (senha com 6 ou mais caracteres)."; return; }
    if (!telefone.startsWith("55")) telefone = "55" + telefone;
    $("btn-cad-mot").disabled = true;
    try {
      const c = await createUserWithEmailAndPassword(authSec, email, senha);
      await setDoc(doc(db,"motoristas",c.user.uid), { nome, telefone, email, pixChave, ativo:true, validoAte: Timestamp.fromMillis(Date.now() + PLANO.dias * 86400000), criadoEm:serverTimestamp() });
      await signOut(authSec);
      ["m-nome","m-telefone","m-email","m-senha","m-pix"].forEach(i => $(i).value = "");
      $("m-erro").style.color = "#2E7D5B"; $("m-erro").textContent = "Motorista cadastrado!";
    } catch (e) { $("m-erro").textContent = e.code === "auth/email-already-in-use" ? "Este e-mail já tem conta. Use outro e-mail." : erroMsg(e); }
    $("btn-cad-mot").disabled = false;
  };
}

$("lista").addEventListener("click", e => {
  const ch = e.target.closest("[data-chat]"); if (ch) { abrirChat(ch.dataset.chat, ch.dataset.nome); return; }
  const b = e.target.closest("button[data-id]"); if (!b) return;
  const a = b.dataset.a;
  if (a === "aguardar") { updateDoc(doc(db,"chamados",b.dataset.id), { aviso:"aguardar" }).catch(() => alert("Não foi possível avisar.")); return; }
  if (a === "aceito") { aceitar(b.dataset.id); return; }
  updateDoc(doc(db,"chamados",b.dataset.id), { status:"finalizado", finalizadoEm:serverTimestamp() }).catch(() => alert("Não foi possível finalizar."));
  abaMot("hist");
});
$("lista-hist").addEventListener("click", e => { if (e.target.closest("[data-pix]") && EU) abrirPix(EU.pixNome, EU.pix); });
$("pix-fechar").onclick = () => $("pix-tela").classList.add("hidden");
$("pix-copiar").onclick = async () => {
  try { await navigator.clipboard.writeText(pixAtual); $("pix-copiar").textContent = "Código copiado!"; }
  catch { prompt("Copie o código Pix:", pixAtual); }
  setTimeout(() => $("pix-copiar").textContent = "Copiar código Pix", 2000);
};
document.addEventListener("click", () => { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); }, { once:true });

/* ---------- Chat da corrida ---------- */
let chatId = null, chatMsgs = [], chatUnsub = null, chatAberto = false, lidas = new Set(), chatPrimeira = true, aoMudarChat = () => {};
const naoLidas = () => chatMsgs.filter(m => m.de !== auth.currentUser?.uid && !lidas.has(m.id)).length;
function monitorarChat(id){
  if (id === chatId) return;
  if (chatUnsub) { chatUnsub(); chatUnsub = null; }
  chatId = id; chatMsgs = []; lidas = new Set(); chatPrimeira = true;
  if (!id) { chatAberto = false; $("chat-tela").classList.add("hidden"); aoMudarChat(); return; }
  chatUnsub = onSnapshot(query(collection(db,"chamados",id,"mensagens"), orderBy("criadoEm")), snap => {
    const novo = !chatPrimeira && snap.docChanges().some(c => c.type === "added" && c.doc.data().de !== auth.currentUser?.uid);
    chatPrimeira = false;
    chatMsgs = snap.docs.map(d => ({id:d.id, ...d.data()}));
    if (chatAberto) chatMsgs.forEach(m => lidas.add(m.id));
    if (novo) beep();
    desenharChat(); aoMudarChat();
  }, () => {});
}
function desenharChat(){
  const eu = auth.currentUser?.uid, box = $("chat-msgs");
  box.innerHTML = chatMsgs.length ? chatMsgs.map(m => `<div class="msg ${m.de === eu ? "eu" : "outro"}">${esc(m.texto)}<small>${m.criadoEm ? fmt(m.criadoEm,true) : ""}</small></div>`).join("")
    : `<p class="vazio">Nenhuma mensagem ainda. Use os atalhos abaixo.</p>`;
  box.scrollTop = box.scrollHeight;
}
function abrirChat(id, nome){
  if (chatId !== id) monitorarChat(id);
  chatAberto = true; chatMsgs.forEach(m => lidas.add(m.id));
  $("chat-titulo").textContent = "Conversa com " + nome;
  $("chat-rapidas").innerHTML = (EU ? ["Estou a caminho","Cheguei","Onde você está?"] : ["Estou aqui","Estou na frente","Pode vir"]).map(t => `<button type="button">${t}</button>`).join("");
  $("chat-tela").classList.remove("hidden"); desenharChat(); aoMudarChat();
}
async function enviarMsg(texto){
  texto = texto.trim(); if (!texto || !chatId) return;
  try { await addDoc(collection(db,"chamados",chatId,"mensagens"), { de:auth.currentUser.uid, texto:texto.slice(0,300), criadoEm:serverTimestamp() }); }
  catch { alert("Não foi possível enviar. A corrida pode ter terminado."); }
}
$("chat-enviar").onclick = () => { const i = $("chat-input"); enviarMsg(i.value); i.value = ""; };
$("chat-input").addEventListener("keydown", e => { if (e.key === "Enter") $("chat-enviar").click(); });
$("chat-rapidas").onclick = e => { const b = e.target.closest("button"); if (b) enviarMsg(b.textContent); };
$("chat-fechar").onclick = () => { chatAberto = false; $("chat-tela").classList.add("hidden"); };

/* ---------- Compartilhar o app e trabalhe conosco ---------- */
const LINK_APP = location.origin + location.pathname;
let qrApp = false;
document.querySelectorAll("[data-share]").forEach(b => b.onclick = () => {
  if (!qrApp && window.QRCode) { new QRCode($("share-qr"), { text: LINK_APP, width:240, height:240, correctLevel: QRCode.CorrectLevel.M }); qrApp = true; }
  $("share-tela").classList.remove("hidden");
});
$("share-fechar").onclick = () => $("share-tela").classList.add("hidden");
const copiarLink = async () => { try { await navigator.clipboard.writeText(LINK_APP); $("share-copiar").textContent = "Link copiado!"; } catch { prompt("Copie o link:", LINK_APP); } setTimeout(() => $("share-copiar").textContent = "Copiar link", 2000); };
$("share-copiar").onclick = copiarLink;
if (!navigator.share) $("share-nativo").classList.add("hidden");
$("share-nativo").onclick = () => navigator.share({ title:"LZ EXPRESS", text:"Peça seu moto táxi pelo LZ EXPRESS:", url:LINK_APP }).catch(() => {});
const zapAdm = String(MOTORISTA_ZAP || "").replace(/\D/g,"");
const zapLink = txt => zapAdm ? "https://wa.me/" + (zapAdm.length > 11 ? zapAdm : "55" + zapAdm) + "?text=" + encodeURIComponent(txt) : "";
let PLANO = { dias:15, valor:100 }, solicitacao = null, notaId = null, ultCh = null, mapa = null, mkP = null, mkM = null;
const brl = v => "R$ " + Number(v).toFixed(2).replace(".", ",");
function atualizarPlanoUI(){
  document.querySelectorAll(".t-dias").forEach(e => e.textContent = PLANO.dias + (PLANO.dias === 1 ? " dia" : " dias"));
  document.querySelectorAll(".t-valor").forEach(e => e.textContent = brl(PLANO.valor));
  $("plano-adm-txt").textContent = "Plano: " + PLANO.dias + " dias grátis · " + brl(PLANO.valor) + "/mês";
}
function atualizarParceiro(){
  const st = solicitacao ? solicitacao.status : "";
  $("bloco-trabalhe").classList.remove("hidden");
  $("btn-trabalhe").textContent = st === "pendente" ? "Solicitação enviada" : "Saiba mais";
  const travado = st === "pendente" || st === "aprovada";
  $("parc-form").classList.toggle("hidden", travado);
  $("parc-estado").textContent = st === "pendente" ? "Solicitação enviada! O administrador vai entrar em contato pelo WhatsApp." : st === "aprovada" ? "Você foi aprovado! Feche e abra o app para ver o painel de motorista." : st === "recusada" ? "Sua solicitação anterior não foi aprovada. Você pode enviar de novo." : "";
}
$("btn-trabalhe").onclick = () => $("parceiro-tela").classList.remove("hidden");
$("parc-fechar").onclick = () => $("parceiro-tela").classList.add("hidden");
$("parc-aceite").onchange = () => { $("parc-enviar").disabled = !$("parc-aceite").checked; };
$("parc-enviar").onclick = async () => {
  const u = auth.currentUser; if (!u || !$("parc-aceite").checked) return;
  $("parc-enviar").disabled = true;
  try {
    const d = (await getDoc(doc(db,"users",u.uid))).data() || {};
    await setDoc(doc(db,"solicitacoes",u.uid), { nome:d.nome || "", telefone:d.telefone || "", email:u.email, status:"pendente", aceiteEm:serverTimestamp(), versaoTermos:"1.0", criadoEm:serverTimestamp() });
    $("parc-aceite").checked = false;
  } catch { alert("Não foi possível enviar. Tente de novo."); }
  $("parc-enviar").disabled = !$("parc-aceite").checked;
};
$("btn-pagar").onclick = () => abrirPix("Leandro Vanzeler · Mercado Pago", montarPix(PIX_CHAVE, "Leandro Vanzeler", PLANO.valor),
  "Pague " + brl(PLANO.valor) + " e avise o administrador. Ele libera seu acesso depois de conferir o pagamento.", zapLink("Paguei a mensalidade do LZ EXPRESS."));

/* ---------- Avaliação e localização do motorista ---------- */
$("estrelas").onclick = async e => {
  const b = e.target.closest("button[data-n]"); if (!b || !notaId) return;
  const id = notaId; notaId = null; $("nota-tela").classList.add("hidden");
  try { await updateDoc(doc(db,"chamados",id), { nota:Number(b.dataset.n) }); } catch { alert("Não foi possível enviar a avaliação."); }
};
$("nota-depois").onclick = () => {
  try { const ig = JSON.parse(localStorage.getItem("lz_ign") || "[]"); ig.push(notaId); localStorage.setItem("lz_ign", JSON.stringify(ig.slice(-50))); } catch {}
  notaId = null; $("nota-tela").classList.add("hidden");
};
const km = (a,b,c,d) => { const r = x => x * Math.PI / 180, h = Math.sin(r(c-a)/2)**2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d-b)/2)**2; return 12742 * Math.asin(Math.sqrt(h)); };
function desenharLoc(){
  const c = ultCh;
  if (!c || !c.motoristaPos) { $("loc-info").textContent = "Aguardando o GPS do motorista..."; return; }
  const p = c.motoristaPos, d = km(c.lat, c.lng, p.lat, p.lng), min = Math.max(1, Math.round(d / 25 * 60)), seg2 = Math.max(0, Math.round((Date.now() - p.t) / 1000));
  $("loc-info").textContent = "Motorista a " + (d < 1 ? Math.round(d * 1000) + " m" : d.toFixed(1).replace(".", ",") + " km") + " de você · cerca de " + min + " min · atualizado há " + (seg2 < 90 ? seg2 + " s" : Math.round(seg2 / 60) + " min");
  $("loc-abrir").href = "https://www.google.com/maps/search/?api=1&query=" + p.lat + "," + p.lng;
  if (!window.L) return;
  if (!mapa) {
    mapa = L.map("loc-mapa", { zoomControl:false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom:19, attribution:"© OpenStreetMap" }).addTo(mapa);
    mkP = L.circleMarker([c.lat, c.lng], { radius:9, color:"#fff", weight:3, fillColor:"#2f7bff", fillOpacity:1 }).addTo(mapa);
    mkM = L.circleMarker([p.lat, p.lng], { radius:9, color:"#fff", weight:3, fillColor:"#f2a82d", fillOpacity:1 }).addTo(mapa);
  }
  mkP.setLatLng([c.lat, c.lng]); mkM.setLatLng([p.lat, p.lng]);
  mapa.invalidateSize(); mapa.fitBounds([[c.lat, c.lng], [p.lat, p.lng]], { padding:[30,30], maxZoom:17 });
}
$("btn-loc-cli").onclick = () => { $("loc-tela").classList.remove("hidden"); desenharLoc(); };
$("loc-fechar").onclick = () => $("loc-tela").classList.add("hidden");
let gpsId = null, gpsWatch = null, gpsUlt = 0;
function seguirGPS(id){
  if (id === gpsId) return;
  if (gpsWatch !== null) { navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; }
  gpsId = id;
  if (!id || !navigator.geolocation) return;
  gpsWatch = navigator.geolocation.watchPosition(p => {
    const t = Date.now(); if (t - gpsUlt < 10000) return; gpsUlt = t;
    updateDoc(doc(db,"chamados",id), { motoristaPos:{ lat:p.coords.latitude, lng:p.coords.longitude, t } }).catch(() => {});
  }, () => {}, { enableHighAccuracy:true, maximumAge:5000 });
}

/* ---------- PWA ---------- */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
let promptInstalar;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); promptInstalar = e; $("instalar").classList.remove("hidden"); });
$("btn-instalar").onclick = async () => { $("instalar").classList.add("hidden"); promptInstalar?.prompt(); };
