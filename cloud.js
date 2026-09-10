(function(){
  let client=null;
  let activeSessionId=null;
  const cfg=window.INVENTORY_CONFIG||{};
  function getClient(){
    if(client)return client;
    if(!cfg.supabaseUrl||!cfg.supabasePublishableKey||!window.supabase)return null;
    client=window.supabase.createClient(cfg.supabaseUrl,cfg.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true}});
    return client;
  }
  async function session(){const c=getClient();if(!c)return null;const {data}=await c.auth.getSession();return data.session;}
  async function signIn(email,password){const c=getClient();if(!c)throw new Error('雲端設定尚未完成');const {data,error}=await c.auth.signInWithPassword({email,password});if(error)throw error;return data.user;}
  async function signOut(){const c=getClient();if(c)await c.auth.signOut();}
  async function ensureActiveSession(orderParts){
    const c=getClient();
    const found=await c.from('inventory_sessions').select('id,name,status').eq('status','ACTIVE').order('created_at',{ascending:false}).limit(1);
    if(found.error)throw found.error;
    let current=found.data?.[0];
    if(!current&&orderParts.length){
      const created=await c.from('inventory_sessions').insert({name:'首次全面盤點',status:'ACTIVE',snapshot_at:new Date().toISOString()}).select('id,name,status').single();
      if(created.error)throw created.error;
      current=created.data;
    }
    if(current&&orderParts.length){
      const rows=orderParts.map(op=>({session_id:current.id,order_part_id:op.id,book_qty_snapshot:op.book_qty,workflow_status:'NOT_STARTED'}));
      const inserted=await c.from('inventory_targets').upsert(rows,{onConflict:'session_id,order_part_id',ignoreDuplicates:true});
      if(inserted.error)throw inserted.error;
    }
    activeSessionId=current?.id||null;
    return current;
  }
  async function loadState(){
    const c=getClient();if(!c)throw new Error('雲端設定尚未完成');
    const [locRes,opRes]=await Promise.all([
      c.from('locations').select('id,code,name').eq('is_active',true).order('code'),
      c.from('order_parts').select('id,book_qty,ordered_qty,orders!inner(order_no),parts!inner(id,part_no,name,drawing_no)')
    ]);
    if(locRes.error)throw locRes.error;if(opRes.error)throw opRes.error;
    const current=await ensureActiveSession(opRes.data||[]);
    const locations=(locRes.data||[]).map(l=>({id:l.code,dbId:l.id,name:l.name}));
    if(!current)return {locations,parts:[],counts:[]};
    const targetRes=await c.from('inventory_targets').select('id,order_part_id,book_qty_snapshot,workflow_status').eq('session_id',current.id);
    if(targetRes.error)throw targetRes.error;
    const byOrderPart=new Map((opRes.data||[]).map(op=>[op.id,op]));
    const parts=(targetRes.data||[]).map(t=>{const op=byOrderPart.get(t.order_part_id);return {id:t.id,targetId:t.id,orderPartId:t.order_part_id,partDbId:op?.parts?.id,order:op?.orders?.order_no||'待確認',no:op?.parts?.part_no||'未知',name:op?.parts?.name||'未知構件',drawingNo:op?.parts?.drawing_no||'',book:t.book_qty_snapshot,workflow:t.workflow_status};});
    const targetIds=parts.map(p=>p.targetId);
    let countRows=[];
    if(targetIds.length){const result=await c.from('count_entries').select('id,target_id,location_id,actual_qty,version_check_status,verified_at,note,recorded_at,is_void').in('target_id',targetIds).eq('is_void',false);if(result.error)throw result.error;countRows=result.data||[];}
    const locationByDb=new Map((locRes.data||[]).map(l=>[l.id,l.code]));
    return {locations,parts,counts:countRows.map(r=>({id:r.id,partId:r.target_id,location:locationByDb.get(r.location_id)||'未知',locationDbId:r.location_id,qty:r.actual_qty,verified:r.version_check_status!=='UNCHECKED',note:r.note||'',at:r.recorded_at}))};
  }
  async function saveCount({part,location,qty,verified,note}){
    const c=getClient();
    const existing=await c.from('count_entries').select('id,actual_qty,version_check_status,note').eq('target_id',part.targetId).eq('location_id',location.dbId).eq('is_void',false).maybeSingle();
    if(existing.error)throw existing.error;
    const payload={actual_qty:qty,version_check_status:verified?'BASELINE_CREATED':'UNCHECKED',verified_at:verified?new Date().toISOString():null,note:note||null,updated_at:new Date().toISOString()};
    let result;
    if(existing.data){
      result=await c.from('count_entries').update(payload).eq('id',existing.data.id).select().single();
      if(!result.error)await c.from('audit_logs').insert({entity_type:'count_entry',entity_id:existing.data.id,action:'UPDATE',before_data:existing.data,after_data:payload,reason:'現場更正'});
    }else{
      result=await c.from('count_entries').insert({...payload,target_id:part.targetId,location_id:location.dbId}).select().single();
      if(!result.error)await c.from('audit_logs').insert({entity_type:'count_entry',entity_id:result.data.id,action:'CREATE',after_data:payload});
    }
    if(result.error)throw result.error;
    await c.from('inventory_targets').update({workflow_status:'IN_PROGRESS'}).eq('id',part.targetId);
    return result.data;
  }
  async function importItems(items){
    const c=getClient();
    const orderPayload=[...new Map(items.map(i=>[i.order,{order_no:i.order}])).values()];
    const partPayload=[...new Map(items.map(i=>[i.no,{part_no:i.no,name:i.name}])).values()];
    const [or,pr]=await Promise.all([
      c.from('orders').upsert(orderPayload,{onConflict:'order_no'}).select('id,order_no'),
      c.from('parts').upsert(partPayload,{onConflict:'part_no'}).select('id,part_no')
    ]);
    if(or.error)throw or.error;if(pr.error)throw pr.error;
    const orderIds=new Map(or.data.map(x=>[x.order_no,x.id])),partIds=new Map(pr.data.map(x=>[x.part_no,x.id]));
    const rows=items.map(i=>({order_id:orderIds.get(i.order),part_id:partIds.get(i.no),ordered_qty:i.orderedValues?.length?Math.max(...i.orderedValues):null,book_qty:i.book}));
    const saved=await c.from('order_parts').upsert(rows,{onConflict:'order_id,part_id'}).select('id,book_qty');
    if(saved.error)throw saved.error;
    await ensureActiveSession(saved.data||[]);
    return saved.data.length;
  }
  window.cloud={configured:Boolean(cfg.supabaseUrl&&cfg.supabasePublishableKey),session,signIn,signOut,loadState,saveCount,importItems};
})();
