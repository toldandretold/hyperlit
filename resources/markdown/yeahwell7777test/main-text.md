To Do: layerTwoContainer Class ==============================

theory ------

instead of creating custom container divs for each use case, and adding the html in differently each time, I should create a layer-2 container class...​

this a common set of attributes, which has different settings established on the initialisation of an instance of the class.​

for example, it will need a "start position: "some css?", visible: boolean, height: width: settings... ​

these settings will have a default, but can also be updated via local storage... where user's settings might exist. ​

why? because, then, if user customises their workspace, these settings are saved for next time. ​​

For this to be possible, the layer-2 containers themselves need to be redesigned. They need areas, maybe at the bottom, and top, which can be drag and dropped. and they need areas, say in each corner, which when drag-dropped resizes the window. because the main area of the div is scrollable, re-sizing can just increase how much user would scroll the layer-2 container. ​

however, there should also be settings for changing the size of the text, depending on the size of the layer-2 container... this is useful for people who want to re-size the hyperlight-container, for example, such that it fits outside, or to the right, of the main-content div... ​

the default will be how i have it. The settings default mode will return to this. But, if that settings thing is a drop down menu, it can automatically feature "most recent", or favourite. After adjusting the view settings, a button should exist "save settings".​ when pressed, it comes up with "name: " field. user can name their current view settings... then, when go to settings, it will be in the drop down menu.

this can feature fully customisable CSS... ​

Some of these view settings will, of course, come from the settings button itself. For example, text size, etc. The settings button should, therefore, exist in each div... be a part of the layer-2-container Class itself... maybe not a settings cog, but just an "Aa" button...

​reset?   

-----------

​it will be re-set by a settings button to be added to the bottom left of viewport.... ​

how to​ -------

so, whenever clicking to use/view a container-div, the logic should first check, is one already initialised? if it is, we can proceed straight to openContainer()... logic... that is, unhide it. in this scenario, we just toggle visibility as we already do... and it already knows the info required to bring it into view... its before and after position and dimension info, rate of coming unhidden, and so on and so forth... which are stored in local storage... ​

however, if a user changes the container-divs position or size by dragging to move or draggin to resize, then the after positions for that container-div are updated to local storage... thus, even on refresh, it will all return to current workstation... view settings... ​

​so, need to work out, how can we set up some default settings in local storage... and get them to be used on opening, for example, the highlight container... then, we set up the highlight-container to rely on a class that uses this info... ​

then, we can update the highlight-container so it features a header and footer that allow for resizing and moving... and the javascript that uses the position and size data after change event to update the info in local storage... thus, at this stage, the only way to reset is to clear browser... but that's fine... we can work on resets and creating custom view profiles and so on and so forth later. ​

once that is done, the good thing is that we can begin saving our own settings that we like... testing out what will be the optimum default settings, for each browser window size... for example...