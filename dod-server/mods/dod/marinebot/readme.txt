
   Marine Bot 0.97 Beta Readme File


DISTRIBUTION PERMISSIONS AND DISCLAIMER
This program may be distributed in any way provided that you keep the entire package complete and credit the authors. You may NOT charge in any way for ownership of, or access to, this program without the prior consent of the author, either in writing or via email. I will almost certainly agree if it is to be included on a magazine CD or other similar medium, but Games Fusion and the like will never get my consent.

This software is provided 'as is'. There is no warranty, expressed or implied, or technical support, although I will endeavour to answer all queries. The author is not responsible for any loss of data or any other damage resulting from the use or misuse of this program. Likewise the author cannot be held responsible for the use or misuse of this software by third parties. Use of this software is AT YOUR OWN RISK!

This software is BETA. This means it has not undergone full and rigorous testing on mulitple system setups, and may cause your computer to crash or become unstable. If you experience any problems please let me know.

The source code for this software is released under the terms of the GNU Public Licence and is available soon after release from www.marinebot.xf.cz and/or https://sourceforge.net/projects/marinebot/ along with full details of the Licence.


SYSTEM REQUIREMENTS:

Any PC capable of running Half-Life will be able to run Marine Bot.
You will require a copy Half-Life and the Day of Defeat mod. Marine Bot 0.97 Beta is designed for Day of Defeat in version 1.3 for Steam.


CHANGELOG:

Please see the file version_history.txt installed in your 'marinebot' folder for a full changelog.


INSTALLATION:

Make sure you have a working copy of Day of Defeat 1.3 before you install Marine Bot!


Instructions for Dedicated Server admins:

1) Extract the archive using a relevant extraction program to your 'dod' folder. Ensure you allow the directory structure when you extract.

2) Do NOT edit your 'liblist.gam' file. Keep it referring to Metamod library.
   If your server runs on Windows machine then add the following command to the command line or script you use to start your server: +localinfo mm_gamedll marinebot/marine_bot.dll
   If your server runs on Linux machine then add the following command to the command line or script you use to start your server: +localinfo mm_gamedll marinebot/marinebot.so


Instructions for gamers:

Common Gamer - Extract the archive using a relevant extraction program to your Day of Defeat 1.3 folder. Ensure you allow the directory structure when you extract. Then open your DoD folder. If you are Windows user then locate the program 'liblist_install_mb.exe' and run it. If you are Linux user open the termial inside your DoD folder and type following command: wine liblist_install_mb.exe. The installation is complete!

Gamer with Adminmod/Metamod - Extract the archive using a relevant extraction program to your Day of Defeat 1.3 folder, but do NOT edit your 'liblist.gam' file, i.e. do NOT run the 'liblist_install_mb.exe' program. Then open your Steam client. Next steps depend on what view mode you are using. In Small Mode or Large Mode you'll have to right click on Day of Defeat, select Properties and Set launch options. In Big Picture Mode you'll have to left click on Day of Defeat, then Manage game and finally Set launch options. And add the following command to the new dialog box: +localinfo mm_gamedll marinebot/marine_bot.dll (or +localinfo mm_gamedll marinebot/marinebot.so in case of Linux)


UNINSTALLATION:


Instructions for Dedicated Server admins:

1) Remove the '+localinfo mm_gamedll' entry referring to Marine Bot library from the command line or script you use to start your server.

2) You can then delete your 'marinebot' folder and both 'liblist_install_mb.exe' and 'liblist_uninstall_mb.exe' (if they are present).


Instructions for gamers:

Common Gamer - In order to play Day of Defeat 1.3 normally again, you will need to open your DoD folder. If you are Windows user then find the program 'liblist_uninstall_mb.exe' and run it. If you are Linux user then open the terminal there and type following command: wine liblist_uninstall_mb.exe. You can then delete your 'marinebot' folder and both 'liblist_install_mb.exe' and 'liblist_uninstall_mb.exe'.

Gamer with Adminmod/Metamod - Do NOT run the 'liblist_uninstall_mb.exe' program. You'll have to open the launch options dialog box the same way you've done during installation and remove the '+localinfo mm_gamedll marinebot/marine_bot.dll' (or +localinfo mm_gamedll marinebot/marinebot.so) command from it. Then delete the 'marinebot' folder and both 'liblist_install_mb.exe' and 'liblist_uninstall_mb.exe' that are in your DoD folder.


CONTROLLING MARINE BOT

You can control Marine Bot using the menu bound to your END key that gives you basic control over your bots in Day of Defeat. Note that this is for a listenserver only. See the console_commands.html file for a full listing of all commands available on a dedicated server as well as on a listenserver.



CREDITS AND CONTRIBUTIONS


The Marine Bot Team
-------------------

Well there is no team at all. Since version 0.92b it is just me Frank McNeil who does the work.


Former Marine Bot Team
----------------------

Founder, Lead Programmer: Frank McNeil
Team Coordinator, Emailing, Throwing Rocks From Afar: Drek

Programming: _shadow_fa
Linux conversion: Sargeant.Rock, _shadow_fa

Documentation: Drek, Frank McNeil, Modest Genius
Artwork: ThChosenOne

Waypointers: Drek, Frank McNeil, Modest Genius
Testers: Drek, Modest Genius, Mosef, Sargeant.Rock


Ex Team Members
---------------

Buv: Linux Testing
Cervezas: Waypointing
Cpl. Shrike: Programming
Creslin: Testing, Linux
Elektra: Forums Administration
glendale2x: Linux
gregor: Waypointing, Testing
Loule: Waypointing
Mav: Programming
oldmanbob: Lead Waypointer, Testing
Pastorn: Waypointing, Testing
Recce: Waypointing
Rogacz: Testing
Seeker: Waypointing, Testing
Spicoli: Testing
Wyx: Waypointing


Website
-------

www.marinebot.xf.cz
https://sourceforge.net/projects/marinebot/


Former website Hosting and Maintainance: Sargeant.Rock
marinebot.net domain funding: Sargeant.Rock


External Contributors and Other Credits
---------------------------------------

Some parts of this program are based on Botman's HPB bot template. Thanks Botman! You can download Botman's templates and get help on using them or any aspect of programming your own bot at http://hpb-bot.bots-united.com/

Marine Bot was an officially supported project of United Admins (www.unitedadmins.com), and all content was available via their website. Thanks to UA for all their help.

Some waypoints have been created externally. Credits for these appear when they are loaded.
Marine Bot Linux versions 0.92b and 0.93b have been put together by RoboCop [APG] Clan Leader.

Thanks to Zneaker (BoCbot author) for some advice in the beginning.
Very special thanks to Cale "Mazor" Dunlap (Firearms coder) who was always helpful and gave MB team access to Firearms betas.
Special thanks to all those who mirror Marine Bot or waypoints.
Thanks to all server admins running Marine Bot on their servers.
Thanks to YIS at http://www.yis.us/ for generous hosting offer.
Thanks to all who have contributed with ideas, suggestions and bug reports on our forums or by email.




Contact
-------

If you have any questions, or find any problems that aren't already addressed in the FAQ or other documentation, you can contact me using the email contact at marinebot.xf.cz
If you get error trying to access marinebot.xf.cz then click to the address bar of your browser and erase the trailing "s" letter from the "https" and try it again. This way you'll be accessing the site in an insecure mode. Marine Bot is using a free web host where the https protocol isn't available by default.

Please remember to include all details of Day of Defeat, Half-Life, Steam and Marine Bot versions. The more information you give me on your problem, the easier it will be for me to help you.

Please note that I work on Marine Bot in my spare time as a hobby, and therefore it may be some time before I get back to you.


And finally thanks to you for playing with Marine Bot!