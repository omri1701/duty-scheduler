'use client';
import {useTeamWorkspace} from '@/hooks/use-team-workspace';
import {RotaWorkspace} from '@/components/rota/workspace';
import {AccessScreen} from '@/components/auth/access-screen';
export default function Home(){const remote=useTeamWorkspace();return remote.me?.status==='approved'&&remote.me.active&&remote.state?<RotaWorkspace key={remote.user!.id} remote={remote}/>:<AccessScreen remote={remote}/>;}
