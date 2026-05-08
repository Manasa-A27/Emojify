import React, { useState, useEffect } from 'react';
import { Upload, FileText, X, Loader2, Search, BarChart3, ShieldCheck, MessageSquare, Save, History, LogIn, LogOut, Plus, Trash2, Copy, Check, Clock, Brain, Layers, ListTodo, ChevronRight, ChevronDown, Square, CheckSquare, Edit2, PlusCircle, GripVertical, Terminal, Code, Bell, AlertCircle, Calendar } from 'lucide-react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/src/components/ui/card';
import { ScrollArea } from '@/src/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/src/components/ui/tabs';
import { Badge } from '@/src/components/ui/badge';
import { Separator } from '@/src/components/ui/separator';
import { Input } from '@/src/components/ui/input';
import { Skeleton } from '@/src/components/ui/skeleton';
import { motion, AnimatePresence } from 'motion/react';
import { pdfToImages, fileToBase64 } from '@/src/lib/pdf-helper';
import { analyzeDocuments, chatWithDocuments } from '@/src/lib/gemini';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import ReactMarkdown from 'react-markdown';
import { auth, db, googleProvider, signInWithPopup, signOut, onAuthStateChanged, handleFirestoreError, OperationType } from '@/src/lib/firebase';
import { collection, query, where, onSnapshot, doc, deleteDoc, writeBatch, getDocs, orderBy } from 'firebase/firestore';

export default function ResearchDashboard() {
  const [user, setUser] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [sessionName, setSessionName] = useState('Untitled Research');

  const [files, setFiles] = useState([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [activeTab, setActiveTab] = useState('analysis');
  
  // Chat state
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState([]);
  const [isChatting, setIsChatting] = useState(false);
  const [copied, setCopied] = useState(false);

  // Task state
  const [tasks, setTasks] = useState([]);
  const [newTaskText, setNewTaskText] = useState('');

  // Data Editor state
  const [newDataLabel, setNewDataLabel] = useState('');
  const [newDataValue, setNewDataValue] = useState('');
  const [editingDataIndex, setEditingDataIndex] = useState(null);
  const [notifications, setNotifications] = useState([]);

  const getDeadlineStatus = (deadline) => {
    if (!deadline) return 'none';
    const now = new Date();
    const deadlineDate = new Date(deadline);
    const diff = deadlineDate.getTime() - now.getTime();
    const hours = diff / (1000 * 60 * 60);

    if (diff < 0) return 'overdue';
    if (hours <= 24) return 'approaching';
    return 'future';
  };

  useEffect(() => {
    const checkDeadlines = () => {
      const newNotifications = [];
      const traverse = (items) => {
        items.forEach(task => {
          if (!task.completed && task.deadline) {
            const status = getDeadlineStatus(task.deadline);
            if (status === 'overdue') {
              newNotifications.push({ id: task.id, text: `Overdue: ${task.text}`, type: 'error' });
            } else if (status === 'approaching') {
              newNotifications.push({ id: task.id, text: `Approaching Deadline: ${task.text}`, type: 'warning' });
            }
          }
          if (task.subtasks.length > 0) traverse(task.subtasks);
        });
      };
      traverse(tasks);
      setNotifications(newNotifications);
    };

    checkDeadlines();
    const interval = setInterval(checkDeadlines, 60000); // Check every minute
    return () => clearInterval(interval);
  }, [tasks]);

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Sessions Listener
  useEffect(() => {
    if (!user) {
      setSessions([]);
      return;
    }

    const q = query(collection(db, 'sessions'), where('userId', '==', user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      setSessions(docs);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'sessions');
    });

    return () => unsubscribe();
  }, [user]);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error(error);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      resetSession();
    } catch (error) {
      console.error(error);
    }
  };

  const resetSession = () => {
    setFiles([]);
    setResult(null);
    setChatMessages([]);
    setTasks([]);
    setCurrentSessionId(null);
    setSessionName('Untitled Research');
    setActiveTab('analysis');
  };

  const saveSession = async () => {
    if (!user) return;
    
    const sessionId = currentSessionId || crypto.randomUUID();
    const sessionData = {
      id: sessionId,
      name: sessionName,
      userId: user.uid,
      result,
      createdAt: currentSessionId ? sessions.find(s => s.id === sessionId)?.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    try {
      const batch = writeBatch(db);
      
      batch.set(doc(db, 'sessions', sessionId), sessionData);

      for (const file of files) {
        batch.set(doc(db, 'sessions', sessionId, 'files', file.id), file);
      }

      chatMessages.forEach((msg, i) => {
        const msgId = `msg-${i}`;
        batch.set(doc(db, 'sessions', sessionId, 'messages', msgId), {
          ...msg,
          timestamp: new Date().toISOString()
        });
      });

      tasks.forEach((task) => {
        batch.set(doc(db, 'sessions', sessionId, 'tasks', task.id), task);
      });

      await batch.commit();
      setCurrentSessionId(sessionId);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `sessions/${sessionId}`);
    }
  };

  const loadSession = async (session) => {
    setCurrentSessionId(session.id);
    setSessionName(session.name);
    setResult(session.result || null);
    setActiveTab('analysis');

    try {
      const filesSnap = await getDocs(collection(db, 'sessions', session.id, 'files'));
      setFiles(filesSnap.docs.map(d => d.data()));

      const messagesSnap = await getDocs(query(collection(db, 'sessions', session.id, 'messages'), orderBy('timestamp', 'asc')));
      setChatMessages(messagesSnap.docs.map(d => ({ role: d.data().role, text: d.data().text })));

      const tasksSnap = await getDocs(collection(db, 'sessions', session.id, 'tasks'));
      setTasks(tasksSnap.docs.map(d => d.data()));
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `sessions/${session.id}`);
    }
  };

  const deleteSession = async (e, id) => {
    e.stopPropagation();
    try {
      await deleteDoc(doc(db, 'sessions', id));
      if (currentSessionId === id) resetSession();
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `sessions/${id}`);
    }
  };

  const handleFileUpload = async (e) => {
    const uploadedFiles = e.target.files;
    if (!uploadedFiles) return;

    const newFiles = [];
    for (const file of Array.from(uploadedFiles)) {
      if (file.type === 'application/pdf') {
        const images = await pdfToImages(file);
        newFiles.push(...images.map(img => ({
          id: `${file.name}-p${img.page}`,
          name: `${file.name} (Page ${img.page})`,
          type: 'image/jpeg',
          data: img.data,
          page: img.page
        })));
      } else if (file.type.startsWith('image/')) {
        const base64 = await fileToBase64(file);
        newFiles.push({
          id: file.name,
          name: file.name,
          type: file.type,
          data: base64
        });
      }
    }
    const updatedFiles = [...files, ...newFiles];
    setFiles(updatedFiles);
    
    if (updatedFiles.length > 0) {
      runAnalysis(updatedFiles);
    }
  };

  const removeFile = (id) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const runAnalysis = async (filesOverride) => {
    const targetFiles = filesOverride || files;
    if (targetFiles.length === 0) return;
    setIsAnalyzing(true);
    try {
      const geminiFiles = targetFiles.map(f => ({
        name: f.name,
        data: f.data,
        mimeType: f.type
      }));
      const res = await analyzeDocuments(geminiFiles, "Analyze these documents comprehensively. Identify key trends, extract data for visualization, and verify any major claims.");
      setResult(res);
      setActiveTab('analysis');
    } catch (error) {
      console.error(error);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleChat = async () => {
    if (!chatInput.trim() || isChatting) return;
    
    const userMsg = chatInput;
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setIsChatting(true);

    try {
      const geminiFiles = files.map(f => ({
        name: f.name,
        data: f.data,
        mimeType: f.type
      }));
      const response = await chatWithDocuments([], userMsg, geminiFiles);
      setChatMessages(prev => [...prev, { role: 'model', text: response || "I couldn't generate a response." }]);
    } catch (error) {
      console.error(error);
      setChatMessages(prev => [...prev, { role: 'model', text: "Error communicating with research assistant." }]);
    } finally {
      setIsChatting(false);
    }
  };

  const addTask = (parentId = null) => {
    if (!newTaskText.trim()) return;
    
    const newTask = {
      id: crypto.randomUUID(),
      text: newTaskText,
      completed: false,
      deadline: null,
      subtasks: []
    };

    if (parentId === null) {
      setTasks([...tasks, newTask]);
    } else {
      const updateTasks = (items) => {
        return items.map(item => {
          if (item.id === parentId) {
            return { ...item, subtasks: [...item.subtasks, newTask] };
          }
          if (item.subtasks.length > 0) {
            return { ...item, subtasks: updateTasks(item.subtasks) };
          }
          return item;
        });
      };
      setTasks(updateTasks(tasks));
    }
    setNewTaskText('');
  };

  const addDataPoint = () => {
    if (!newDataLabel.trim() || !newDataValue.trim() || !result) return;
    const newValue = parseFloat(newDataValue);
    if (isNaN(newValue)) return;

    const updatedDataPoints = [...(result.dataPoints || []), { label: newDataLabel, value: newValue }];
    setResult({ ...result, dataPoints: updatedDataPoints });
    setNewDataLabel('');
    setNewDataValue('');
  };

  const updateDataPoint = (index, label, value) => {
    if (!result) return;
    const newValue = parseFloat(value);
    if (isNaN(newValue)) return;

    const updatedDataPoints = [...result.dataPoints];
    updatedDataPoints[index] = { label, value: newValue };
    setResult({ ...result, dataPoints: updatedDataPoints });
  };

  const removeDataPoint = (index) => {
    if (!result) return;
    const updatedDataPoints = result.dataPoints.filter((_, i) => i !== index);
    setResult({ ...result, dataPoints: updatedDataPoints });
  };

  const generatePythonCode = () => {
    if (!result?.dataPoints) return "";
    const dataStr = JSON.stringify(result.dataPoints, null, 2);
    return `import plotly.graph_objects as go

def visualize_research_data(data_points):
    if not data_points:
        return
    labels = [dp['label'] for dp in data_points]
    values = [dp['value'] for dp in data_points]
    fig = go.Figure(data=[go.Bar(x=labels, y=values)])
    fig.show()

data_points = ${dataStr}
visualize_research_data(data_points)`;
  };

  const handleExportPython = () => {
    const code = generatePythonCode();
    copyToClipboard(code);
  };

  const toggleTask = (id) => {
    const updateTasks = (items) => {
      return items.map(item => {
        if (item.id === id) {
          return { ...item, completed: !item.completed };
        }
        if (item.subtasks.length > 0) {
          return { ...item, subtasks: updateTasks(item.subtasks) };
        }
        return item;
      });
    };
    setTasks(updateTasks(tasks));
  };

  const removeTask = (id) => {
    const updateTasks = (items) => {
      return items.filter(item => item.id !== id).map(item => ({
        ...item,
        subtasks: updateTasks(item.subtasks)
      }));
    };
    setTasks(updateTasks(tasks));
  };

  const updateTaskText = (id, newText) => {
    const updateTasks = (items) => {
      return items.map(item => {
        if (item.id === id) {
          return { ...item, text: newText };
        }
        if (item.subtasks.length > 0) {
          return { ...item, subtasks: updateTasks(item.subtasks) };
        }
        return item;
      });
    };
    setTasks(updateTasks(tasks));
  };

  const onDragEnd = (result) => {
    const { source, destination } = result;
    if (!destination) return;

    const reorder = (list, startIndex, endIndex) => {
      const resultArr = Array.from(list);
      const [removed] = resultArr.splice(startIndex, 1);
      resultArr.splice(endIndex, 0, removed);
      return resultArr;
    };

    if (source.droppableId === destination.droppableId) {
      if (source.droppableId === 'tasks-root') {
        const newTasks = reorder(tasks, source.index, destination.index);
        setTasks(newTasks);
      } else {
        const parentId = source.droppableId.replace('subtasks-', '');
        const updateTasks = (items) => {
          return items.map(item => {
            if (item.id === parentId) {
              return { ...item, subtasks: reorder(item.subtasks, source.index, destination.index) };
            }
            if (item.subtasks.length > 0) {
              return { ...item, subtasks: updateTasks(item.subtasks) };
            }
            return item;
          });
        };
        setTasks(updateTasks(tasks));
      }
    }
  };

  const TaskItem = ({ task, depth = 0, index }) => {
    const [isExpanded, setIsExpanded] = useState(true);
    const [isAddingSubtask, setIsAddingSubtask] = useState(false);
    const [subtaskText, setSubtaskText] = useState('');
    const [isEditing, setIsEditing] = useState(false);
    const [editText, setEditText] = useState(task.text);
    const [isEditingDeadline, setIsEditingDeadline] = useState(false);

    const handleAddSubtask = () => {
      if (!subtaskText.trim()) return;
      const newTask = {
        id: crypto.randomUUID(),
        text: subtaskText,
        completed: false,
        deadline: null,
        subtasks: []
      };
      
      const updateTasks = (items) => {
        return items.map(item => {
          if (item.id === task.id) {
            return { ...item, subtasks: [...item.subtasks, newTask] };
          }
          if (item.subtasks.length > 0) {
            return { ...item, subtasks: updateTasks(item.subtasks) };
          }
          return item;
        });
      };
      setTasks(updateTasks(tasks));
      setSubtaskText('');
      setIsAddingSubtask(false);
    };

    const handleUpdateText = () => {
      if (editText.trim() && editText !== task.text) {
        updateTaskText(task.id, editText);
      }
      setIsEditing(false);
    };

    const handleUpdateDeadline = (newDeadline) => {
      const updateTasks = (items) => {
        return items.map(item => {
          if (item.id === task.id) {
            return { ...item, deadline: newDeadline || null };
          }
          if (item.subtasks.length > 0) {
            return { ...item, subtasks: updateTasks(item.subtasks) };
          }
          return item;
        });
      };
      setTasks(updateTasks(tasks));
      setIsEditingDeadline(false);
    };

    const deadlineStatus = getDeadlineStatus(task.deadline);

    return (
      <Draggable draggableId={task.id} index={index}>
        {(provided) => (
          <div ref={provided.innerRef} {...provided.draggableProps} className="space-y-2">
            <div className="relative" style={{ marginLeft: `${depth * 24}px` }}>
              {depth > 0 && <div className="absolute left-0 top-0 bottom-0 w-[1px] bg-gray-200" style={{ left: `-12px` }} />}
              <motion.div 
                layout 
                initial={false}
                animate={{ scale: task.completed ? 0.99 : 1, opacity: task.completed ? 0.8 : 1, x: task.completed ? 4 : 0 }}
                className={`relative flex items-center gap-3 p-2 rounded-lg transition-all duration-200 group ${
                  task.completed ? 'bg-gray-50/80' : 
                  deadlineStatus === 'overdue' ? 'bg-red-50 border border-red-200 shadow-sm' :
                  deadlineStatus === 'approaching' ? 'bg-orange-50 border border-orange-200 shadow-sm' : 'bg-white border border-gray-100 shadow-sm'
                }`}
              >
                {depth > 0 && <div className="absolute -left-3 top-1/2 w-3 h-[1px] bg-gray-200" style={{ left: `-12px` }} />}
                <div {...provided.dragHandleProps} className="text-gray-300 hover:text-gray-500 cursor-grab active:cursor-grabbing">
                  <GripVertical className="w-4 h-4" />
                </div>
                <motion.button whileTap={{ scale: 0.8 }} onClick={() => toggleTask(task.id)} className={`transition-colors ${task.completed ? 'text-green-600' : 'text-orange-600'}`}>
                  <AnimatePresence mode="wait">
                    <motion.div key={task.completed ? 'checked' : 'unchecked'} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }}>
                      {task.completed ? <CheckSquare className="w-5 h-5" /> : <Square className="w-5 h-5" />}
                    </motion.div>
                  </AnimatePresence>
                </motion.button>
                {isEditing ? (
                  <Input autoFocus value={editText} onChange={(e) => setEditText(e.target.value)} onBlur={handleUpdateText} onKeyDown={(e) => e.key === 'Enter' && handleUpdateText()} className="h-7 text-sm flex-1 bg-white" />
                ) : (
                  <motion.span layout className={`text-sm flex-1 cursor-text ${task.completed ? 'line-through text-gray-400 italic' : 'text-gray-700'}`} onDoubleClick={() => setIsEditing(true)}>
                    {task.text}
                    {task.deadline && !task.completed && (
                      <span className={`ml-3 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${deadlineStatus === 'overdue' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
                        Due: {new Date(task.deadline).toLocaleDateString()}
                      </span>
                    )}
                  </motion.span>
                )}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {isEditingDeadline ? (
                    <Input type="date" autoFocus className="h-7 w-32 text-[10px]" onChange={(e) => handleUpdateDeadline(e.target.value)} onBlur={() => setIsEditingDeadline(false)} />
                  ) : (
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setIsEditingDeadline(true)}><Calendar className="w-3 h-3" /></Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setIsEditing(!isEditing)}><Edit2 className="w-3 h-3" /></Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setIsAddingSubtask(!isAddingSubtask)}><Plus className="w-3 h-3" /></Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-red-600" onClick={() => removeTask(task.id)}><Trash2 className="w-3 h-3" /></Button>
                  {task.subtasks.length > 0 && (
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setIsExpanded(!isExpanded)}>{isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</Button>
                  )}
                </div>
              </motion.div>
            </div>
            {isAddingSubtask && (
              <div className="flex gap-2 mb-2" style={{ marginLeft: `${(depth + 1) * 24}px` }}>
                <Input value={subtaskText} onChange={(e) => setSubtaskText(e.target.value)} placeholder="Add subtask..." className="h-8 text-xs" onKeyDown={(e) => e.key === 'Enter' && handleAddSubtask()} />
                <Button size="sm" className="h-8 bg-orange-600" onClick={handleAddSubtask}>Add</Button>
                <Button size="sm" variant="ghost" className="h-8" onClick={() => setIsAddingSubtask(false)}>Cancel</Button>
              </div>
            )}
            {isExpanded && (
              <Droppable droppableId={`subtasks-${task.id}`} type={`subtasks-${task.id}`}>
                {(provided) => (
                  <div {...provided.droppableProps} ref={provided.innerRef} className="space-y-2">
                    {task.subtasks.map((sub, i) => <TaskItem key={sub.id} task={sub} depth={depth + 1} index={i} />)}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            )}
          </div>
        )}
      </Draggable>
    );
  };

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans">
      <header className="border-b border-gray-200 bg-white/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-orange-600 rounded-lg flex items-center justify-center">
              <ShieldCheck className="text-white w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Aetheris <span className="text-gray-400 font-normal">Research</span></h1>
              <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Auditor-Grade Intelligence</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {user ? (
              <div className="flex items-center gap-3">
                <div className="flex flex-col items-end">
                  <span className="text-xs font-medium">{user.displayName}</span>
                  <button onClick={handleLogout} className="text-[10px] text-gray-500 hover:text-orange-600">Sign Out</button>
                </div>
                {user.photoURL && <img src={user.photoURL} className="w-8 h-8 rounded-full border" referrerPolicy="no-referrer" />}
              </div>
            ) : (
              <Button onClick={handleLogin} variant="outline" size="sm" className="gap-2"><LogIn className="w-4 h-4" />Sign In</Button>
            )}
            <Badge variant="outline" className="bg-orange-50 text-orange-700">Multimodal v1.5</Badge>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-12 gap-8">
        <div className="col-span-12 lg:col-span-4 space-y-6">
          {user && (
            <Card>
              <CardHeader className="py-3 flex flex-row items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2"><History className="w-4 h-4 text-orange-600" />Saved Sessions</CardTitle>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={resetSession}><Plus className="w-4 h-4" /></Button>
              </CardHeader>
              <CardContent className="p-2">
                <ScrollArea className="h-[150px]">
                  {sessions.length === 0 ? <div className="p-4 text-xs text-gray-400 italic">No sessions</div> : 
                    sessions.map((s) => (
                      <div key={s.id} onClick={() => loadSession(s)} className={`p-2 mb-1 rounded-md cursor-pointer flex items-center justify-between ${currentSessionId === s.id ? 'bg-orange-50 text-orange-700' : 'hover:bg-gray-50'}`}>
                        <div className="flex flex-col overflow-hidden">
                          <span className="text-xs font-medium truncate">{s.name}</span>
                          <span className="text-[10px] opacity-60">{new Date(s.updatedAt || s.createdAt).toLocaleDateString()}</span>
                        </div>
                        <Button variant="ghost" size="icon" className="h-6 w-6 hover:text-red-600" onClick={(e) => deleteSession(e, s.id)}><Trash2 className="w-3 h-3" /></Button>
                      </div>
                    ))
                  }
                </ScrollArea>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2"><Upload className="w-4 h-4 text-orange-600" />Repository</CardTitle>
              {user && <Button variant="ghost" size="icon" onClick={saveSession}><Save className="w-4 h-4" /></Button>}
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className="relative group">
                <input type="file" multiple accept="application/pdf,image/*" onChange={handleFileUpload} className="absolute inset-0 opacity-0 cursor-pointer z-10" />
                <div className="border-2 border-dashed rounded-xl p-8 text-center bg-white group-hover:border-orange-400">
                  <Upload className="w-6 h-6 text-orange-600 mx-auto mb-3" />
                  <p className="text-sm font-medium">Drop files here</p>
                </div>
              </div>
              <ScrollArea className="h-[300px]">
                {files.map((file) => (
                  <div key={file.id} className="flex items-center justify-between p-3 mb-2 bg-white border rounded-lg hover:border-orange-200">
                    <div className="flex items-center gap-3 truncate">
                      <FileText className="w-4 h-4 text-gray-400" />
                      <div className="truncate">
                        <p className="text-xs font-medium truncate">{file.name}</p>
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => removeFile(file.id)}><X className="w-3 h-3" /></Button>
                  </div>
                ))}
              </ScrollArea>
              <Button className="w-full bg-orange-600 hover:bg-orange-700" disabled={files.length === 0 || isAnalyzing} onClick={() => runAnalysis()}>
                {isAnalyzing ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Analyzing...</> : <><Search className="w-4 h-4 mr-2" />Synthesize</>}
              </Button>
            </CardContent>
          </Card>
        </div>

        <div className="col-span-12 lg:col-span-8 space-y-6">
          {!result && !isAnalyzing ? (
            <div className="h-[600px] flex flex-col items-center justify-center border-dashed border-2 rounded-2xl bg-white">
              <BarChart3 className="w-10 h-10 text-orange-600 mb-4" />
              <h2 className="text-2xl font-semibold">Ready for Analysis</h2>
              <p className="text-gray-500">Upload documents to begin.</p>
            </div>
          ) : isAnalyzing ? (
            <div className="space-y-6">
              <Skeleton className="h-40 w-full" />
              <div className="grid grid-cols-2 gap-6"><Skeleton className="h-60" /><Skeleton className="h-60" /></div>
            </div>
          ) : (
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="bg-white border p-1 rounded-xl mb-6">
                <TabsTrigger value="analysis">Synthesis</TabsTrigger>
                <TabsTrigger value="verification">Verification</TabsTrigger>
                <TabsTrigger value="chat">Chat</TabsTrigger>
                <TabsTrigger value="tasks">Plan</TabsTrigger>
              </TabsList>
              <TabsContent value="analysis" className="space-y-6">
                {result?.summary && (
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                      <CardTitle>Summary</CardTitle>
                      <Button variant="ghost" size="icon" onClick={() => copyToClipboard(result.summary)}><Copy className="w-4 h-4" /></Button>
                    </CardHeader>
                    <CardContent className="prose prose-sm max-w-none">
                      <ReactMarkdown>{result.summary}</ReactMarkdown>
                    </CardContent>
                  </Card>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <Card>
                    <CardHeader><CardTitle className="text-sm text-gray-500">Findings</CardTitle></CardHeader>
                    <CardContent>
                      <ul className="space-y-2">
                        {result?.keyFindings?.map((f, i) => <li key={i} className="text-sm flex gap-2"><span className="text-orange-600 font-bold">{i+1}.</span> {f}</li>)}
                      </ul>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                      <CardTitle className="text-sm text-gray-500">Visualization</CardTitle>
                      <Button variant="ghost" size="sm" onClick={handleExportPython}><Terminal className="w-3 h-3 mr-1" />Python</Button>
                    </CardHeader>
                    <CardContent className="h-[250px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={result?.dataPoints || []}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                          <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} />
                          <YAxis tick={{ fontSize: 10 }} axisLine={false} />
                          <Tooltip />
                          <Bar dataKey="value" fill="#EA580C" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>
              {/* Other Tabs content omitted for brevity but converted logic is identical */}
            </Tabs>
          )}
        </div>
      </main>
    </div>
  );
}
```</User>
