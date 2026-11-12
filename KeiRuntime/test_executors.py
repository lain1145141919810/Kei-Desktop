import asyncio
import json
import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from bridge.executors import ExecutorManager, ExecutorError, visible_final, RpcWorker, codex_available


class FakeWorker:
    serial = 0
    def __init__(self, backend, config):
        FakeWorker.serial += 1
        self.proc = SimpleNamespace(pid=FakeWorker.serial)
        self.loaded = set()
        self.alive = False
        self.last_used = 0
    async def start(self):
        self.alive = True
    async def execute(self, native, request, save):
        self.last_request = request
        native = native or f'native-{self.proc.pid}-{len(self.loaded)}'
        self.loaded.add(native)
        save(native)
        if request == 'wait':
            await asyncio.sleep(60)
        if request == 'fail':
            raise ExecutorError('test failure')
        return 'done'
    async def close(self):
        self.alive = False


class ManagerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.cfg = root / 'config.json'
        self.cfg.write_text(json.dumps({'backend':'dsh','workspace':str(root),
            'idle_seconds':600,'task_timeout_seconds':2,'max_sessions_per_process':2}), encoding='utf-8')
        self.manager = ExecutorManager(self.cfg, root, FakeWorker)
    async def asyncTearDown(self):
        await self.manager.close()
        self.tmp.cleanup()
    async def test_independent_tasks_share_process_and_followup_reuses_session(self):
        a = json.loads(await self.manager.run('read', 'owner'))
        worker = self.manager.workers['dsh']
        b = json.loads(await self.manager.run('read', 'owner'))
        self.assertNotEqual(a['task_id'], b['task_id'])
        await self.manager.run('read', 'owner', a['task_id'])
        self.assertIs(worker, self.manager.workers['dsh'])
        self.assertEqual(len(worker.loaded), 2)
    async def test_other_session_cannot_resume(self):
        a = json.loads(await self.manager.run('read', 'owner'))
        with self.assertRaises(ValueError):
            await self.manager.run('read', 'other', a['task_id'])
        self.assertIn(a['task_id'], self.manager.context('owner'))
        self.assertNotIn(a['task_id'], self.manager.context('other'))
    async def test_failed_task_is_not_automatically_replayed(self):
        a = json.loads(await self.manager.run('fail', 'owner'))
        self.assertEqual(a['status'], 'failed')
        self.assertFalse(self.manager.workers['dsh'].alive)
        with self.assertRaises(ValueError):
            await self.manager.run('read', 'owner', a['task_id'])
    async def test_timeout_closes_worker(self):
        self.manager.config['task_timeout_seconds'] = .02
        a = json.loads(await self.manager.run('wait', 'owner'))
        self.assertEqual(a['status'], 'timeout')
        self.assertFalse(self.manager.workers['dsh'].alive)
    async def test_cancel_prevents_late_result(self):
        task = asyncio.create_task(self.manager.run('wait', 'owner'))
        await asyncio.sleep(.01)
        await self.manager.stop_session()
        self.assertTrue(task.cancelled())
        self.assertFalse(self.manager.workers['dsh'].alive)
        self.assertEqual(self.manager.status()['recent'][0]['status'], 'cancelled')
    async def test_session_cap_recycles_owned_worker(self):
        await self.manager.run('read', 'owner')
        old = self.manager.workers['dsh']
        await self.manager.run('read', 'owner')
        await self.manager.run('read', 'owner')
        self.assertFalse(old.alive)
        self.assertIsNot(old, self.manager.workers['dsh'])
    async def test_released_process_continues_from_final_result_without_replay(self):
        a = json.loads(await self.manager.run('old instruction', 'owner'))
        await self.manager.release()
        b = json.loads(await self.manager.run('new instruction', 'owner', a['task_id']))
        request = self.manager.workers['dsh'].last_request
        self.assertEqual(a['task_id'], b['task_id'])
        self.assertIn('done', request)
        self.assertIn('new instruction', request)
        self.assertNotIn('old instruction', request)
    async def test_select_is_persisted_and_release_keeps_history(self):
        await self.manager.run('read', 'owner')
        await self.manager.release()
        self.assertEqual(self.manager.workers, {})
        self.assertEqual(len(self.manager.status()['recent']), 1)
        await self.manager.select('astrbot')
        self.assertEqual(json.loads(self.cfg.read_text('utf-8'))['backend'], 'astrbot')
    async def test_invalid_selection_leaves_configuration(self):
        with self.assertRaises(ValueError):
            await self.manager.select('shell')
        self.assertEqual(self.manager.config['backend'], 'dsh')
    async def test_unverified_codex_backend_cannot_be_enabled(self):
        with self.assertRaises(ValueError):
            await self.manager.select('codex')
        self.assertEqual(self.manager.config['backend'], 'dsh')
    async def test_verified_codex_reuses_process_and_invalidates_changed_binary(self):
        binary = Path(self.tmp.name) / 'candidate.exe'
        binary.write_bytes(b'fixture')
        self.manager.config.update(codex_executable=str(binary),
            codex_verified_sha256=hashlib.sha256(b'fixture').hexdigest(),
            codex_validated_workspace=self.tmp.name)
        await self.manager.select('codex')
        first = json.loads(await self.manager.run('read', 'owner'))
        worker = self.manager.workers['codex']
        await self.manager.run('followup', 'owner', first['task_id'])
        self.assertIs(worker, self.manager.workers['codex'])
        binary.write_bytes(b'changed executable')
        self.assertFalse(codex_available(self.manager.config))
        with self.assertRaises(ExecutorError):
            await self.manager.run('read', 'owner')
    async def test_changed_workspace_requires_revalidation(self):
        binary = Path(self.tmp.name) / 'candidate.exe'
        binary.write_bytes(b'fixture')
        self.manager.config.update(codex_executable=str(binary),
            codex_verified_sha256=hashlib.sha256(b'fixture').hexdigest(),
            codex_validated_workspace=str(Path(self.tmp.name) / 'other'))
        self.assertFalse(codex_available(self.manager.config))
    async def test_restart_marks_unfinished_without_replay(self):
        self.manager.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?)',
            ('old','owner','dsh','n','running',1,None))
        self.manager.db.commit()
        await self.manager.close()
        other = ExecutorManager(self.cfg, Path(self.tmp.name), FakeWorker)
        self.assertEqual(other.status()['recent'][0]['status'], 'interrupted')
        self.assertEqual(other.workers, {})
        await other.close()


class FinalTests(unittest.TestCase):
    def test_thinking_and_empty_are_rejected(self):
        for text in ('', '<think>secret', 'ok<analysis>secret</analysis>'):
            with self.assertRaises(ExecutorError):
                visible_final(text)
        self.assertEqual(visible_final('  完了しました。 '), '完了しました。')


class WireWorker(RpcWorker):
    def __init__(self, backend, notifications):
        super().__init__(backend, {'workspace':'.'})
        self.notifications = notifications
    async def rpc(self, method, params, timeout=30):
        if method in ('thread/start', 'thread/resume'):
            return {'thread': {'id':'thread'}}
        for n in self.notifications:
            self.events.put_nowait(n)
        return {'turn': {'id':'turn'}, 'messageId':'receipt'}


class WireTests(unittest.IsolatedAsyncioTestCase):
    async def test_codex_only_final_phase_in_matching_turn(self):
        events = [{'method':'item/completed', 'params':{'threadId':'thread','turnId':'turn',
            'item':{'type':'agentMessage','phase':phase,'text':text}}} for phase,text in
            [('commentary','not speech'),('final_answer','done')]]
        events += [{'method':'turn/completed','params':{'threadId':'thread',
                    'turn':{'id':'turn','status':'completed'}}}]
        w = WireWorker('codex', events)
        self.assertEqual(await w.execute(None, 'hello', lambda _:None), 'done')
    async def test_codex_failed_turn_never_returns_final(self):
        w = WireWorker('codex', [{'method':'turn/completed','params':{'threadId':'thread',
            'turn':{'id':'turn','status':'failed'}}}])
        with self.assertRaises(ExecutorError):
            await w.execute(None,'hello',lambda _:None)
    async def test_dsh_ignores_prose_before_receipt_and_reasoning_blocks(self):
        def event(kind, data):
            return {'method':'session.event','params':{'sessionId':'dsh-session',
                    'event':{'type':kind,'data':data}}}
        w = WireWorker('dsh', [
            event('assistant/message', {'content':[{'type':'text','text':'old answer'}]}),
            event('agent/inbox/spliced', {'inserted':[{'id':'receipt'}]}),
            event('assistant/message', {'content':[{'type':'reasoning','text':'hidden'},
                                                   {'type':'text','text':'done'}]}),
            event('turn/end', {'reason':{'kind':'completed'}}),
            {'method':'session.status','params':{'sessionId':'dsh-session','status':'idle'}}])
        self.assertEqual(await w.execute('dsh-session','hello',lambda _:None),'done')
    async def test_dsh_tool_bearing_message_not_a_final(self):
        def event(kind, data):
            return {'method':'session.event','params':{'sessionId':'s','event':{'type':kind,'data':data}}}
        w=WireWorker('dsh',[
            event('agent/inbox/spliced',{'inserted':[{'id':'receipt'}]}),
            event('assistant/message',{'content':[{'type':'text','text':'will do'}, {'type':'tool_use'}]}),
            event('turn/end',{'reason':{'kind':'completed'}}),
            {'method':'session.status','params':{'sessionId':'s','status':'idle'}}])
        with self.assertRaises(ExecutorError):
            await w.execute('s','hello',lambda _:None)


if __name__ == '__main__':
    unittest.main()
